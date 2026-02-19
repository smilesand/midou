/**
 * MCP 客户端管理器 — midou 的扩展触手
 * 
 * 连接外部 MCP 服务器，让 midou 获得更多能力。
 * 就像猫咪伸出爪子探索新事物。
 * 
 * 配置文件: ~/.midou/mcp.json
 * 格式:
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
 *       "env": { "KEY": "value" }
 *     }
 *   }
 * }
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import config from '../midou.config.js';

const MCP_CONFIG_FILE = path.join(config.workspace.root, 'mcp.json');

/**
 * MCP 服务器连接
 */
class MCPConnection {
  constructor(name, serverConfig) {
    this.name = name;
    this.config = serverConfig;
    this.process = null;
    this.tools = [];
    this.connected = false;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._buffer = '';
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MCP 服务器 ${this.name} 连接超时`));
      }, 15000);

      try {
        const env = { ...process.env, ...(this.config.env || {}) };
        this.process = spawn(this.config.command, this.config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          cwd: this.config.cwd || undefined,
        });

        this.process.stdout.on('data', (data) => {
          this._handleData(data.toString());
        });

        this.process.stderr.on('data', (data) => {
          // MCP 服务器的 stderr 通常是日志
          // 不做处理，避免干扰
        });

        this.process.on('error', (err) => {
          clearTimeout(timeout);
          this.connected = false;
          reject(new Error(`MCP 服务器 ${this.name} 启动失败: ${err.message}`));
        });

        this.process.on('close', () => {
          this.connected = false;
        });

        // 发送 initialize 请求
        this._sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'midou', version: '0.1.0' },
        }).then(async (result) => {
          clearTimeout(timeout);
          this.connected = true;

          // 发送 initialized 通知
          this._sendNotification('notifications/initialized', {});

          // 获取工具列表
          await this._discoverTools();

          resolve(result);
        }).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * 处理从服务器收到的数据
   */
  _handleData(data) {
    this._buffer += data;

    // JSON-RPC 消息以换行分隔
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        // 响应消息
        if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
          const { resolve, reject } = this._pendingRequests.get(msg.id);
          this._pendingRequests.delete(msg.id);

          if (msg.error) {
            reject(new Error(`MCP Error: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
        // 通知消息忽略
      } catch {
        // 解析失败，忽略
      }
    }
  }

  /**
   * 发送 JSON-RPC 请求
   */
  _sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this.process.stdin.write(msg + '\n');
    });
  }

  /**
   * 发送 JSON-RPC 通知（无需响应）
   */
  _sendNotification(method, params = {}) {
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });
    this.process.stdin.write(msg + '\n');
  }

  /**
   * 发现服务器提供的工具
   */
  async _discoverTools() {
    try {
      const result = await this._sendRequest('tools/list', {});
      this.tools = (result.tools || []).map(tool => ({
        ...tool,
        _mcpServer: this.name,
      }));
    } catch {
      this.tools = [];
    }
  }

  /**
   * 调用一个工具
   */
  async callTool(toolName, args) {
    if (!this.connected) {
      throw new Error(`MCP 服务器 ${this.name} 未连接`);
    }

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    // 提取文本内容
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }

    return JSON.stringify(result);
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.process) {
      this.process.stdin.end();
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this._pendingRequests.clear();
  }
}

// ────────────────────── MCP 管理器 ──────────────────────

let connections = new Map();

/**
 * 加载 MCP 配置
 */
async function loadMCPConfig() {
  try {
    const data = await fs.readFile(MCP_CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 连接所有配置的 MCP 服务器
 */
export async function connectMCPServers() {
  const mcpConfig = await loadMCPConfig();
  if (!mcpConfig?.mcpServers) return [];

  const results = [];

  for (const [name, serverConfig] of Object.entries(mcpConfig.mcpServers)) {
    const conn = new MCPConnection(name, serverConfig);
    try {
      await conn.connect();
      connections.set(name, conn);
      results.push({
        name,
        status: 'connected',
        tools: conn.tools.map(t => t.name),
      });
    } catch (err) {
      results.push({
        name,
        status: 'failed',
        error: err.message,
      });
    }
  }

  return results;
}

/**
 * 获取所有已连接服务器的工具列表
 * 返回 OpenAI function calling 格式的工具定义
 */
export function getMCPToolDefinitions() {
  const tools = [];

  for (const [serverName, conn] of connections) {
    if (!conn.connected) continue;

    for (const tool of conn.tools) {
      tools.push({
        type: 'function',
        function: {
          name: `mcp_${serverName}_${tool.name}`,
          description: `[MCP: ${serverName}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
        _mcpServer: serverName,
        _mcpToolName: tool.name,
      });
    }
  }

  return tools;
}

/**
 * 判断一个工具名称是否是 MCP 工具
 */
export function isMCPTool(toolName) {
  return toolName.startsWith('mcp_');
}

/**
 * 执行 MCP 工具调用
 */
export async function executeMCPTool(toolName, args) {
  // 解析：mcp_{serverName}_{toolName}
  const parts = toolName.replace(/^mcp_/, '').split('_');

  // 找到匹配的服务器
  for (const [serverName, conn] of connections) {
    if (toolName.startsWith(`mcp_${serverName}_`)) {
      const actualToolName = toolName.replace(`mcp_${serverName}_`, '');
      return await conn.callTool(actualToolName, args);
    }
  }

  throw new Error(`未找到 MCP 工具: ${toolName}`);
}

/**
 * 断开所有 MCP 连接
 */
export function disconnectAll() {
  for (const conn of connections.values()) {
    conn.disconnect();
  }
  connections.clear();
}

/**
 * 获取 MCP 连接状态
 */
export function getMCPStatus() {
  const status = [];
  for (const [name, conn] of connections) {
    status.push({
      name,
      connected: conn.connected,
      toolCount: conn.tools.length,
      tools: conn.tools.map(t => t.name),
    });
  }
  return status;
}

/**
 * 检查是否有 MCP 配置
 */
export async function hasMCPConfig() {
  try {
    await fs.access(MCP_CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建 MCP 状态提示词
 */
export function buildMCPPrompt() {
  const status = getMCPStatus();
  if (status.length === 0) return '';

  const lines = ['你已连接以下 MCP 扩展服务器：\n'];
  for (const s of status) {
    const state = s.connected ? '✅' : '❌';
    lines.push(`- ${state} **${s.name}** (${s.toolCount} 个工具): ${s.tools.join(', ')}`);
  }
  lines.push('\n使用 MCP 工具时，工具名格式为 `mcp_{服务器名}_{工具名}`。');

  return lines.join('\n');
}
