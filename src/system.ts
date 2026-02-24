/**
 * SystemManager — midou 的组织大脑
 *
 * 负责 Agent 生命周期管理、MCP 连接、Cron 任务调度、
 * 消息总线和插件加载。
 */

import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import type { Server as SocketIOServer } from 'socket.io';
import type { Express } from 'express';
import { Agent } from './agent.js';
import { initMemory, memoryManager } from './memory.js';
import { connectMCPServers, disconnectAll, getMCPToolDefinitions } from './mcp.js';
import { loadPlugins } from './plugin.js';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  AgentConfig,
  AgentData,
  AgentInterface,
  ConnectionConfig,
  OutputHandler,
  SystemManagerInterface,
  SystemConfig,
} from './types.js';

const SYSTEM_CONFIG_FILE = path.join(MIDOU_WORKSPACE_DIR, 'system.json');

/**
 * SystemManager — 全局单例
 */
export class SystemManager implements SystemManagerInterface {
  io: SocketIOServer;
  agents: Map<string, Agent>;
  connections: ConnectionConfig[];
  private _cronJobs: cron.ScheduledTask[];
  private _app: Express;
  outputHandlerMiddlewares: Array<(agent: AgentInterface, handler: OutputHandler) => OutputHandler | void>;

  constructor(io: SocketIOServer, app: Express) {
    this.io = io;
    this.agents = new Map();
    this.connections = [];
    this._cronJobs = [];
    this._app = app;
    this.outputHandlerMiddlewares = [];
  }

  /**
   * 加载系统配置并初始化所有子系统
   */
  async loadSystem(): Promise<void> {
    // 1. 初始化记忆系统
    await initMemory();

    // 2. 读取系统配置
    let config: SystemConfig = { agents: [], connections: [] };
    try {
      const data = await fs.readFile(SYSTEM_CONFIG_FILE, 'utf-8');
      config = JSON.parse(data) as SystemConfig;
    } catch {
      console.log('[System] 未找到系统配置文件，使用默认配置');
      config = this._defaultConfig();
    }

    // 3. 初始化 MCP
    if (config.mcpServers) {
      await connectMCPServers(config.mcpServers);
    }

    // 4. 加载插件
    await loadPlugins(this, this._app);

    // 5. 创建 Agents
    this.connections = config.connections || [];
    for (const agentConf of config.agents) {
      await this._createAgent(agentConf);
    }

    // 6. 设置 Cron 任务
    this._setupCronJobs();

    console.log(
      `[System] 系统初始化完成 — ${this.agents.size} 个 Agent, ` +
      `${this.connections.length} 个连接, ` +
      `${getMCPToolDefinitions().length} 个 MCP 工具`
    );
  }

  /**
   * 发送全局事件
   */
  emitEvent(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  /**
   * 获取组织花名册
   */
  getOrganizationRoster(requestingAgentId?: string | null): string {
    const lines: string[] = ['## 组织成员\n'];
    for (const [id, agent] of this.agents) {
      const busy = agent.isBusy ? '🔴 忙碌' : '🟢 空闲';
      const marker = id === requestingAgentId ? ' ← 你' : '';
      lines.push(`- **${agent.name}** (${id}) ${busy}${marker}`);
      if (agent.config.systemPrompt) {
        const desc = agent.config.systemPrompt.slice(0, 80);
        lines.push(`  _${desc}${agent.config.systemPrompt.length > 80 ? '…' : ''}_`);
      }
    }

    if (this.connections.length > 0) {
      lines.push('\n## 连接关系\n');
      for (const conn of this.connections) {
        const src = this.agents.get(conn.source)?.name || conn.source;
        const tgt = this.agents.get(conn.target)?.name || conn.target;
        lines.push(`- ${src} → ${tgt}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理用户消息
   */
  async handleUserMessage(message: string, targetAgentId?: string | null): Promise<void> {
    const target = targetAgentId
      ? this.agents.get(targetAgentId)
      : this.agents.values().next().value;

    if (!target) {
      this.emitEvent('agent:error', {
        error: '没有可用的 Agent',
        agentId: targetAgentId || 'unknown',
      });
      return;
    }

    try {
      await target.talk(message);
    } catch (err: unknown) {
      this.emitEvent('agent:error', {
        error: (err as Error).message,
        agentId: target.id,
      });
    }
  }

  /**
   * 中断 Agent
   */
  interruptAgent(targetAgentId?: string | null): void {
    const agent = targetAgentId
      ? this.agents.get(targetAgentId)
      : this.agents.values().next().value;
    if (agent?.engine) {
      agent.engine.interrupt();
      agent.isBusy = false;
    }
  }

  /**
   * Agent 间通信
   */
  async sendMessage(
    sourceAgentId: string,
    targetAgentId: string,
    message: string,
    _context?: Record<string, unknown>
  ): Promise<string> {
    const target = this.agents.get(targetAgentId);
    if (!target) {
      // 尝试按名称查找
      const byName = Array.from(this.agents.values()).find((a) => a.name === targetAgentId);
      if (byName) {
        byName.receiveMessage(sourceAgentId, message);
        return `消息已发送给 ${byName.name}`;
      }
      return `未找到目标 Agent: ${targetAgentId}`;
    }
    target.receiveMessage(sourceAgentId, message);
    return `消息已发送给 ${target.name}`;
  }

  /**
   * 创建子 Agent
   */
  async createChildAgent(
    parentAgentId: string,
    opts: { name?: string; systemPrompt?: string; task: string }
  ): Promise<string> {
    const id = `child-${Date.now()}`;
    const name = opts.name || `子Agent-${id.slice(-4)}`;

    const agentConfig: AgentConfig = {
      id,
      name,
      data: {
        systemPrompt: opts.systemPrompt || `你是 ${name}，被 ${parentAgentId} 创建来执行特定任务。`,
      },
    };

    const agent = await this._createAgent(agentConfig);

    // 连接父子关系
    this.connections.push({
      id: `conn-${Date.now()}`,
      source: parentAgentId,
      target: id,
    });

    // 立即执行任务
    agent.talk(opts.task).catch((err) => {
      console.error(`[System] 子 Agent ${name} 执行任务失败:`, err);
    });

    return `已创建子 Agent "${name}" (${id}) 并分配任务`;
  }

  /**
   * 构建输出处理器（应用中间件链）
   */
  buildOutputHandler(agent: AgentInterface, baseHandler: OutputHandler): OutputHandler {
    let handler = baseHandler;
    for (const middleware of this.outputHandlerMiddlewares) {
      const result = middleware(agent, handler);
      if (result) handler = result;
    }
    return handler;
  }

  /**
   * 注册输出处理器中间件
   */
  useOutputHandler(
    middleware: (agent: AgentInterface, handler: OutputHandler) => OutputHandler | void
  ): void {
    this.outputHandlerMiddlewares.push(middleware);
  }

  /**
   * 停止所有 Cron 任务
   */
  stopAllCronJobs(): void {
    for (const job of this._cronJobs) {
      job.stop();
    }
    this._cronJobs = [];
  }

  /**
   * 关闭系统
   */
  async shutdown(): Promise<void> {
    console.log('[System] 正在关闭...');
    this.stopAllCronJobs();
    await memoryManager.shutdown();
    await disconnectAll();
    console.log('[System] 已关闭');
  }

  /**
   * 保存系统配置
   */
  async saveSystem(): Promise<void> {
    const config: SystemConfig = {
      agents: Array.from(this.agents.values()).map((agent) => ({
        id: agent.id,
        name: agent.name,
        data: agent.config,
      })),
      connections: this.connections,
    };
    await fs.mkdir(path.dirname(SYSTEM_CONFIG_FILE), { recursive: true });
    await fs.writeFile(SYSTEM_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }

  // ── 内部方法 ──

  private async _createAgent(agentConf: AgentConfig): Promise<Agent> {
    const agent = new Agent(agentConf, this);
    await agent.init();
    this.agents.set(agent.id, agent);
    return agent;
  }

  private _setupCronJobs(): void {
    for (const [, agent] of this.agents) {
      const cronJobs = agent.config.cronJobs || [];

      // 旧格式兼容
      if (agent.config.cron && cronJobs.length === 0) {
        cronJobs.push({ expression: agent.config.cron, prompt: '执行定时任务' });
      }

      for (const job of cronJobs) {
        if (!cron.validate(job.expression)) {
          console.warn(`[System] 无效的 cron 表达式: ${job.expression} (${agent.name})`);
          continue;
        }

        const task = cron.schedule(job.expression, () => {
          console.log(`[Cron] 触发: ${agent.name} — ${job.prompt}`);
          agent.talk(job.prompt).catch((err) => {
            console.error(`[Cron] ${agent.name} 执行失败:`, err);
          });
        });
        this._cronJobs.push(task);
      }
    }
  }

  private _defaultConfig(): SystemConfig {
    return {
      agents: [
        {
          id: 'midou',
          name: 'midou',
          data: {
            systemPrompt: '你是 midou，一个智能助手。你能使用各种工具来帮助用户完成任务。',
          },
        },
      ],
      connections: [],
    };
  }
}
