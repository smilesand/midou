/**
 * SystemManager — midou 的组织大脑
 *
 * 负责 Agent 生命周期管理、MCP 连接、Cron 任务调度、
 * 消息总线和插件加载。
 */

import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import watcher from '@parcel/watcher';
import type { Server as SocketIOServer } from 'socket.io';
import type { Express } from 'express';
import { Agent } from './agent.js';
import { initMemory, memoryManager } from './memory.js';
import { connectMCPServers, disconnectAll, getMCPToolDefinitions } from './mcp.js';
import { loadPlugins } from './plugin.js';
import { PipelineEngine } from './pipeline.js';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  AgentConfig,
  AgentData,
  AgentInterface,
  ConnectionConfig,
  MCPServerConfig,
  OutputHandler,
  SystemManagerInterface,
  SystemConfig,
  PipelineDefinition,
  PipelineEngineInterface,
} from './types.js';

const SYSTEM_CONFIG_FILE = path.join(MIDOU_WORKSPACE_DIR, 'system.json');

/**
 * SystemManager — 全局单例
 */
/** 静默多少毫秒后才触发 Agent（防抖窗口） */
const WATCHER_DEBOUNCE_MS = 5_000;
/** 最长累积时间：即使变更持续不断，超过此值也强制触发 */
const WATCHER_MAX_WAIT_MS = 60_000;

interface WatcherPending {
  timer: NodeJS.Timeout;
  events: watcher.Event[];
  firstEventAt: number;
}

export class SystemManager implements SystemManagerInterface {
  io: SocketIOServer;
  agents: Map<string, Agent>;
  connections: ConnectionConfig[];
  pipelines: PipelineDefinition[];
  pipelineEngine: PipelineEngine | null;
  private _cronJobs: cron.ScheduledTask[];
  private _watcherSubscriptions: watcher.AsyncSubscription[];
  private _watcherPending: Map<string, WatcherPending>;
  private _app: Express;
  private _mcpServers: Record<string, MCPServerConfig>;
  outputHandlerMiddlewares: Array<(agent: AgentInterface, handler: OutputHandler) => OutputHandler | void>;

  constructor(io: SocketIOServer, app: Express) {
    this.io = io;
    this.agents = new Map();
    this.connections = [];
    this.pipelines = [];
    this.pipelineEngine = null;
    this._cronJobs = [];
    this._watcherSubscriptions = [];
    this._watcherPending = new Map();
    this._app = app;
    this._mcpServers = {};
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
      this._mcpServers = config.mcpServers;
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

    // 7. 设置文件感知
    await this._setupWatchPaths();

    // 8. 初始化流水线引擎
    this.pipelines = config.pipelines || [];
    this.pipelineEngine = new PipelineEngine(this);
    this.pipelineEngine.registerPipelines(this.pipelines);
    await this.pipelineEngine.loadRuns();

    console.log(
      `[System] 系统初始化完成 — ${this.agents.size} 个 Agent, ` +
      `${this.connections.length} 个连接, ` +
      `${getMCPToolDefinitions().length} 个 MCP 工具, ` +
      `${this.pipelines.length} 个流水线`
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
   * 停止所有文件感知订阅
   */
  async stopAllWatchers(): Promise<void> {
    // 清除所有待触发的防抖定时器
    for (const pending of this._watcherPending.values()) {
      clearTimeout(pending.timer);
    }
    this._watcherPending.clear();
    await Promise.allSettled(this._watcherSubscriptions.map(s => s.unsubscribe()));
    this._watcherSubscriptions = [];
  }

  /**
   * 关闭系统
   */
  async shutdown(): Promise<void> {
    console.log('[System] 正在关闭...');
    this.stopAllCronJobs();
    await this.stopAllWatchers();
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
        position: agent.position,
        data: agent.config,
      })),
      connections: this.connections,
      mcpServers: this._mcpServers,
      pipelines: this.pipelines,
    };
    await fs.mkdir(path.dirname(SYSTEM_CONFIG_FILE), { recursive: true });
    await fs.writeFile(SYSTEM_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * 从前端数据更新系统配置（保存前端编辑的 Agent 配置、连接关系等）
   */
  async updateFromFrontend(data: {
    agents?: Array<{ id: string; name: string; position?: { x: number; y: number }; data?: AgentData }>;
    connections?: ConnectionConfig[];
    mcpServers?: Record<string, MCPServerConfig>;
    pipelines?: PipelineDefinition[];
  }): Promise<void> {
    // 更新现有 Agent 的配置和位置
    if (data.agents) {
      for (const agentData of data.agents) {
        const agent = this.agents.get(agentData.id);
        if (agent) {
          agent.name = agentData.name;
          agent.position = agentData.position;
          if (agentData.data) {
            agent.updateConfig(agentData.data);
          }
        } else {
          // 新增的 Agent
          const newAgent = await this._createAgent({
            id: agentData.id,
            name: agentData.name,
            position: agentData.position,
            data: agentData.data,
          });
          newAgent.position = agentData.position;
        }
      }

      // 删除前端已移除的 Agent
      const frontendIds = new Set(data.agents.map(a => a.id));
      for (const [id] of this.agents) {
        if (!frontendIds.has(id)) {
          this.agents.delete(id);
        }
      }
    }

    // 更新连接关系
    if (data.connections) {
      this.connections = data.connections;
    }

    // 更新 MCP
    if (data.mcpServers) {
      this._mcpServers = data.mcpServers;
    }

    // 重新配置 Cron
    this.stopAllCronJobs();
    this._setupCronJobs();

    // 重新配置文件感知
    await this.stopAllWatchers();
    await this._setupWatchPaths();

    // 更新流水线
    if (data.pipelines) {
      this.pipelines = data.pipelines;
      if (this.pipelineEngine) {
        this.pipelineEngine.registerPipelines(this.pipelines);
      }
    }

    // 保存到磁盘
    await this.saveSystem();
  }

  // ── 内部方法 ──

  private async _createAgent(agentConf: AgentConfig): Promise<Agent> {
    const agent = new Agent(agentConf, this);
    agent.position = agentConf.position;
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

  /**
   * 防抖调度：将新事件追加到缓冲区，在静默窗口后统一触发 Agent。
   * 若累积时间超过最大等待时间则立即触发（应对持续变更场景）。
   */
  private _scheduleWatcherFlush(agent: Agent, watchPath: string, newEvents: watcher.Event[]): void {
    const key = `${agent.id}::${watchPath}`;
    const now = Date.now();

    let pending = this._watcherPending.get(key);
    if (!pending) {
      pending = { timer: null!, events: [], firstEventAt: now };
      this._watcherPending.set(key, pending);
    }
    pending.events.push(...newEvents);

    // 超过最大累积时长 → 立即触发，不再等待静默窗口
    if (now - pending.firstEventAt >= WATCHER_MAX_WAIT_MS) {
      clearTimeout(pending.timer);
      this._flushWatcherEvents(agent, watchPath);
      return;
    }

    // 重置防抖定时器（每次新事件都重新计时）
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this._flushWatcherEvents(agent, watchPath);
    }, WATCHER_DEBOUNCE_MS);
  }

  private _flushWatcherEvents(agent: Agent, watchPath: string): void {
    const key = `${agent.id}::${watchPath}`;
    const pending = this._watcherPending.get(key);
    if (!pending || pending.events.length === 0) return;

    const events = pending.events;
    this._watcherPending.delete(key);

    const summary = events
      .slice(0, 10)
      .map(e => `[${e.type}] ${e.path}`)
      .join('\n');
    const extra = events.length > 10 ? `\n…以及另外 ${events.length - 10} 个变更` : '';
    const message =
      `【文件感知触发】监控路径 "${watchPath}" 在静默窗口内共检测到 ${events.length} 个文件变更：\n${summary}${extra}\n\n请根据变更内容判断是否需要采取行动。`;

    console.log(`[Watcher] ${agent.name} 触发: ${events.length} 个事件 (${watchPath})`);
    agent.talk(message).catch((e: unknown) => {
      console.error(`[Watcher] ${agent.name} 处理文件变更失败:`, e);
    });
  }

  private async _setupWatchPaths(): Promise<void> {
    for (const [, agent] of this.agents) {
      const watchPaths = agent.config.watchPaths || [];
      for (const watchPath of watchPaths) {
        const trimmed = watchPath.trim();
        if (!trimmed) continue;

        // 检查路径是否存在
        try {
          await fs.access(trimmed);
        } catch {
          console.warn(`[Watcher] 路径不存在，跳过: ${trimmed} (${agent.name})`);
          continue;
        }

        try {
          const subscription = await watcher.subscribe(trimmed, (err, events) => {
            if (err) {
              console.error(`[Watcher] 监听错误 (${agent.name}):`, err);
              return;
            }
            if (!events || events.length === 0) return;
            this._scheduleWatcherFlush(agent, trimmed, events);
          });

          this._watcherSubscriptions.push(subscription);
          console.log(`[Watcher] ${agent.name} 已开始监控: ${trimmed}`);
        } catch (err) {
          console.error(`[Watcher] 无法订阅路径 ${trimmed} (${agent.name}):`, err);
        }
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
