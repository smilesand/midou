/**
 * MCP 客户端管理器 — midou 的扩展触手
 */

import { spawn } from 'child_process';

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
   * 断开连接
   */
  disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.tools = [];
  }

  /**
   * 获取工具列表
   */
  async _discoverTools() {
    try {
      const result = await this._sendRequest('tools/list', {});
      if (result && result.tools) {
        this.tools = result.tools;
      }
    } catch (err) {
      console.error(`获取 MCP 服务器 ${this.name} 工具失败:`, err.message);
    }
  }

  /**
   * 执行工具
   */
  async callTool(name, args) {
    if (!this.connected) {
      throw new Error(`MCP 服务器 ${this.name} 未连接`);
    }
    return await this._sendRequest('tools/call', { name, arguments: args });
  }

  /**
   * 处理接收到的数据 (JSON-RPC)
   */
  _handleData(data) {
    this._buffer += data;
    
    let lines = this._buffer.split('\n');
    this._buffer = lines.pop(); // 保留最后一行（可能不完整）

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        
        if (message.id !== undefined) {
          if (this._pendingRequests.has(message.id)) {
            const { resolve, reject } = this._pendingRequests.get(message.id);
            this._pendingRequests.delete(message.id);
            
            if (message.error) {
              reject(new Error(message.error.message || 'MCP Error'));
            } else {
              resolve(message.result);
            }
          }
        }
      } catch (err) {
        // 忽略解析错误
      }
    }
  }

  /**
   * 发送 JSON-RPC 请求
   */
  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this._pendingRequests.set(id, { resolve, reject });
      
      if (this.process && this.process.stdin) {
        this.process.stdin.write(JSON.stringify(message) + '\n');
      } else {
        reject(new Error('MCP 进程未就绪'));
      }
    });
  }

  /**
   * 发送 JSON-RPC 通知
   */
  _sendNotification(method, params) {
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };
    if (this.process && this.process.stdin) {
      this.process.stdin.write(JSON.stringify(message) + '\n');
    }
  }
}

// 全局连接池
const connections = new Map();

/**
 * 连接所有配置的 MCP 服务器
 */
export async function connectMCPServers(mcpConfig) {
  if (!mcpConfig) return [];

  const results = [];

  for (const [name, config] of Object.entries(mcpConfig)) {
    if (connections.has(name)) {
      connections.get(name).disconnect();
    }

    const conn = new MCPConnection(name, config);
    try {
      await conn.connect();
      connections.set(name, conn);
      results.push({ name, status: 'connected', tools: conn.tools });
    } catch (err) {
      results.push({ name, status: 'error', error: err.message });
    }
  }

  return results;
}

/**
 * 断开所有连接
 */
export async function disconnectAll() {
  for (const conn of connections.values()) {
    conn.disconnect();
  }
  connections.clear();
}

/**
 * 获取所有 MCP 工具定义（转换为 OpenAI 格式）
 */
export function getMCPToolDefinitions() {
  const definitions = [];

  for (const [serverName, conn] of connections.entries()) {
    if (!conn.connected) continue;

    for (const tool of conn.tools) {
      // 为工具名加上前缀，避免冲突
      const toolName = `mcp_${serverName}_${tool.name}`;
      
      definitions.push({
        type: 'function',
        function: {
          name: toolName,
          description: `[MCP: ${serverName}] ${tool.description || ''}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
        // 附加原始信息，执行时需要
        _mcpServer: serverName,
        _mcpToolName: tool.name,
      });
    }
  }

  return definitions;
}

/**
 * 检查是否是 MCP 工具
 */
export function isMCPTool(name) {
  return name.startsWith('mcp_');
}

/**
 * 执行 MCP 工具
 */
export async function executeMCPTool(name, args) {
  // 解析出服务器名和原始工具名
  // 格式: mcp_serverName_toolName
  const parts = name.split('_');
  if (parts.length < 3) {
    return `无效的 MCP 工具名称: ${name}`;
  }

  const serverName = parts[1];
  const toolName = parts.slice(2).join('_');

  const conn = connections.get(serverName);
  if (!conn || !conn.connected) {
    return `MCP 服务器 ${serverName} 未连接`;
  }

  try {
    const result = await conn.callTool(toolName, args);
    
    // 格式化结果
    if (result && result.content && Array.isArray(result.content)) {
      return result.content.map(c => {
        if (c.type === 'text') return c.text;
        return `[${c.type} content]`;
      }).join('\n');
    }
    
    return JSON.stringify(result);
  } catch (err) {
    return `执行 MCP 工具失败: ${err.message}`;
  }
}
