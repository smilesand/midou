/**
 * MCP 客户端管理器 — midou 的扩展触手
 */

import { spawn, type ChildProcess } from 'child_process';
import type { ToolDefinition, MCPServerConfig } from './types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * MCP 服务器连接
 */
class MCPConnection {
  name: string;
  config: MCPServerConfig;
  process: ChildProcess | null;
  tools: MCPToolInfo[];
  connected: boolean;
  private _requestId: number;
  private _pendingRequests: Map<number, PendingRequest>;
  private _buffer: string;

  constructor(name: string, serverConfig: MCPServerConfig) {
    this.name = name;
    this.config = serverConfig;
    this.process = null;
    this.tools = [];
    this.connected = false;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._buffer = '';
  }

  async connect(): Promise<unknown> {
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

        this.process.stdout!.on('data', (data: Buffer) => {
          this._handleData(data.toString());
        });

        this.process.stderr!.on('data', (_data: Buffer) => {
          // MCP 服务器的 stderr 通常是日志
        });

        this.process.on('error', (err: Error) => {
          clearTimeout(timeout);
          this.connected = false;
          reject(
            new Error(
              `MCP 服务器 ${this.name} 启动失败: ${err.message}`
            )
          );
        });

        this.process.on('close', () => {
          this.connected = false;
        });

        this._sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'midou', version: '0.1.0' },
        })
          .then(async (result) => {
            clearTimeout(timeout);
            this.connected = true;

            this._sendNotification('notifications/initialized', {});
            await this._discoverTools();

            resolve(result);
          })
          .catch((err: Error) => {
            clearTimeout(timeout);
            reject(err);
          });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.tools = [];
  }

  async _discoverTools(): Promise<void> {
    try {
      const result = (await this._sendRequest('tools/list', {})) as {
        tools?: MCPToolInfo[];
      };
      if (result && result.tools) {
        this.tools = result.tools;
      }
    } catch (err: unknown) {
      console.error(
        `获取 MCP 服务器 ${this.name} 工具失败:`,
        (err as Error).message
      );
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error(`MCP 服务器 ${this.name} 未连接`);
    }
    return await this._sendRequest('tools/call', { name, arguments: args });
  }

  _handleData(data: string): void {
    this._buffer += data;

    const lines = this._buffer.split('\n');
    this._buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;

        if (message.id !== undefined) {
          if (this._pendingRequests.has(message.id as number)) {
            const { resolve, reject } = this._pendingRequests.get(
              message.id as number
            )!;
            this._pendingRequests.delete(message.id as number);

            if (message.error) {
              reject(
                new Error(
                  ((message.error as Record<string, unknown>).message as string) ||
                    'MCP Error'
                )
              );
            } else {
              resolve(message.result);
            }
          }
        }
      } catch (_err) {
        // 忽略解析错误
      }
    }
  }

  _sendRequest(method: string, params: unknown): Promise<unknown> {
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

  _sendNotification(method: string, params: unknown): void {
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
const connections = new Map<string, MCPConnection>();

export interface MCPConnectResult {
  name: string;
  status: string;
  tools?: MCPToolInfo[];
  error?: string;
}

/**
 * 连接所有配置的 MCP 服务器
 */
export async function connectMCPServers(
  mcpConfig: Record<string, MCPServerConfig>
): Promise<MCPConnectResult[]> {
  if (!mcpConfig) return [];

  const results: MCPConnectResult[] = [];

  for (const [name, cfg] of Object.entries(mcpConfig)) {
    if (connections.has(name)) {
      connections.get(name)!.disconnect();
    }

    const conn = new MCPConnection(name, cfg);
    try {
      await conn.connect();
      connections.set(name, conn);
      results.push({ name, status: 'connected', tools: conn.tools });
    } catch (err: unknown) {
      results.push({ name, status: 'error', error: (err as Error).message });
    }
  }

  return results;
}

/**
 * 断开所有连接
 */
export async function disconnectAll(): Promise<void> {
  for (const conn of connections.values()) {
    conn.disconnect();
  }
  connections.clear();
}

/**
 * 获取所有 MCP 工具定义（转换为 OpenAI 格式）
 */
export function getMCPToolDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];

  for (const [serverName, conn] of connections.entries()) {
    if (!conn.connected) continue;

    for (const tool of conn.tools) {
      const toolName = `mcp_${serverName}_${tool.name}`;

      definitions.push({
        type: 'function',
        function: {
          name: toolName,
          description: `[MCP: ${serverName}] ${tool.description || ''}`,
          parameters: (tool.inputSchema as Record<string, unknown>) || {
            type: 'object',
            properties: {},
          },
        },
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
export function isMCPTool(name: string): boolean {
  return name.startsWith('mcp_');
}

/**
 * 执行 MCP 工具
 */
export async function executeMCPTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
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
    const result = (await conn.callTool(toolName, args)) as {
      content?: Array<{ type: string; text?: string }>;
    };

    if (result && result.content && Array.isArray(result.content)) {
      return result.content
        .map((c) => {
          if (c.type === 'text') return c.text;
          return `[${c.type} content]`;
        })
        .join('\n');
    }

    return JSON.stringify(result);
  } catch (err: unknown) {
    return `执行 MCP 工具失败: ${(err as Error).message}`;
  }
}
