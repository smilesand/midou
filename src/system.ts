import fs from 'fs/promises';
import path from 'path';
import cron, { type ScheduledTask } from 'node-cron';
import { Agent } from './agent.js';
import { connectMCPServers, disconnectAll as disconnectMCP } from './mcp.js';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initRAG, cleanupMemories } from './rag/index.js';
import type { Server as SocketIOServer } from 'socket.io';
import type {
  AgentConfig,
  ConnectionConfig,
  SystemConfig,
  OutputHandler,
  AgentInterface,
  SystemManagerInterface,
} from './types.js';

type OutputHandlerMiddleware = (
  agent: AgentInterface,
  handler: OutputHandler
) => OutputHandler | void;

export class SystemManager implements SystemManagerInterface {
  io: SocketIOServer;
  agents: Map<string, Agent>;
  connections: ConnectionConfig[];
  cronJobs: Map<string, ScheduledTask[]>;
  systemPath: string;
  outputHandlerMiddlewares: OutputHandlerMiddleware[];

  constructor(io: SocketIOServer) {
    this.io = io;
    this.agents = new Map();
    this.connections = [];
    this.cronJobs = new Map();
    this.systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
    this.outputHandlerMiddlewares = [];
  }

  useOutputHandler(middleware: OutputHandlerMiddleware): void {
    if (typeof middleware === 'function') {
      this.outputHandlerMiddlewares.push(middleware);
    }
  }

  buildOutputHandler(agent: AgentInterface, baseHandler: OutputHandler): OutputHandler {
    let handler = { ...baseHandler };
    for (const middleware of this.outputHandlerMiddlewares) {
      try {
        handler = middleware(agent, handler) || handler;
      } catch (err) {
        console.error(
          `[Plugin] Error in output handler middleware for agent ${agent.id}:`,
          err
        );
      }
    }
    return handler;
  }

  async init(): Promise<void> {
    await initRAG();
    await this.loadSystem();

    // Setup daily memory cleanup (forgetting mechanism)
    cron.schedule('0 3 * * *', async () => {
      console.log('[System] Running daily memory cleanup...');
      await cleanupMemories(30, 2);
    });
  }

  async loadSystem(): Promise<void> {
    try {
      const data = await fs.readFile(this.systemPath, 'utf-8');
      const system: SystemConfig = JSON.parse(data);

      // Clear existing
      this.stopAllCronJobs();
      stopHeartbeat();
      this.agents.clear();
      this.connections = system.connections || [];
      await disconnectMCP();

      // Initialize MCP servers
      if (system.mcpServers) {
        console.log('Initializing MCP servers...');
        await connectMCPServers(system.mcpServers);
      }

      // Initialize agents
      for (const agentConfig of system.agents || []) {
        const agent = new Agent(agentConfig, this);
        await agent.init();
        this.agents.set(agent.id, agent);

        // Setup cron if configured
        const agentData = agentConfig.data || agentConfig.config || {};
        if (agentData.cronJobs && Array.isArray(agentData.cronJobs)) {
          for (const job of agentData.cronJobs) {
            if (job.expression) {
              this.setupCronJob(agent.id, job.expression, job.prompt);
            }
          }
        } else if (agentData.cron) {
          this.setupCronJob(
            agent.id,
            agentData.cron,
            'System: Scheduled activation triggered.'
          );
        }
      }

      // Start global heartbeat (e.g., every 60 minutes)
      startHeartbeat(this, 60);

      console.log(
        `System loaded with ${this.agents.size} agents and ${this.connections.length} connections.`
      );
    } catch (error) {
      console.log(
        'No system.json found or error parsing, starting empty system.',
        error
      );
      this.agents.clear();
      this.connections = [];
    }
  }

  setupCronJob(
    agentId: string,
    cronExpression: string,
    prompt: string
  ): void {
    if (!cron.validate(cronExpression)) {
      console.error(
        `Invalid cron expression for agent ${agentId}: ${cronExpression}`
      );
      return;
    }

    const job = cron.schedule(cronExpression, () => {
      const agent = this.agents.get(agentId);
      if (agent) {
        console.log(`[Cron] Triggering agent ${agentId}`);
        agent.talk(prompt || 'System: Scheduled activation triggered.');
      }
    });

    if (!this.cronJobs.has(agentId)) {
      this.cronJobs.set(agentId, []);
    }
    this.cronJobs.get(agentId)!.push(job);
  }

  stopAllCronJobs(): void {
    for (const jobs of this.cronJobs.values()) {
      for (const job of jobs) {
        job.stop();
      }
    }
    this.cronJobs.clear();
  }

  getOrganizationRoster(requestingAgentId: string | null = null): string {
    if (this.agents.size === 0)
      return '目前组织里没有其他 Agent。';

    let roster = '组织花名册：\n';

    if (requestingAgentId) {
      const outgoing = this.connections.filter(
        (c) => c.source === requestingAgentId
      );
      if (outgoing.length > 0) {
        roster +=
          '你可以通过 send_message 工具向以下 用户 发送消息：\n';
        for (const conn of outgoing) {
          const targetAgent = this.agents.get(conn.target);
          if (!targetAgent) continue;

          roster += `- ID: ${targetAgent.id} | 名称: ${targetAgent.name} | 简介: ${targetAgent.config.systemPrompt ? targetAgent.config.systemPrompt.slice(0, 100) + '...' : '无描述'}\n`;
        }
      } else {
        roster +=
          '你当前没有权限向任何其他用户发送消息。\n';
      }
    } else {
      for (const [id, agent] of this.agents.entries()) {
        roster += `- ID: ${id} | 名称: ${agent.name} | 简介: ${agent.config.systemPrompt ? agent.config.systemPrompt.slice(0, 50) + '...' : '无描述'}\n`;
      }
    }

    return roster;
  }

  /**
   * 动态创建子 Agent，完成任务后自动汇报给父 Agent 并销毁
   */
  async createChildAgent(
    parentAgentId: string,
    options: { name?: string; systemPrompt?: string; task: string }
  ): Promise<string> {
    const { name, systemPrompt, task } = options;
    const parentAgent = this.agents.get(parentAgentId);
    if (!parentAgent)
      return `创建失败：找不到父 Agent [${parentAgentId}]`;

    const childId = `child-${Date.now()}`;
    const childConfig: AgentConfig = {
      id: childId,
      name: name || `${parentAgent.name}-helper`,
      data: {
        isAgentMode: true,
        systemPrompt:
          systemPrompt ||
          `你是 ${parentAgent.name} 创建的助手，专门负责完成分配给你的任务。完成后请调用 finish_task 工具提交你的工作成果。`,
        provider: parentAgent.config.provider,
        model: parentAgent.config.model,
        apiKey: parentAgent.config.apiKey,
        baseURL: parentAgent.config.baseURL,
        maxTokens: parentAgent.config.maxTokens,
        maxIterations: parentAgent.config.maxIterations || 10,
      },
    };

    const childAgent = new Agent(childConfig, this);
    await childAgent.init();
    this.agents.set(childId, childAgent);

    // 建立双向连接
    this.connections.push({
      id: `edge-${parentAgentId}-${childId}`,
      source: parentAgentId,
      target: childId,
    });
    this.connections.push({
      id: `edge-${childId}-${parentAgentId}`,
      source: childId,
      target: parentAgentId,
    });

    console.log(
      `[System] 智能体 "${childConfig.name}" (${childId}) 已创建，父 Agent: ${parentAgent.name}`
    );

    // 异步执行任务，完成后将结果汇报给父 Agent 并销毁智能体
    setTimeout(async () => {
      try {
        const result = await childAgent.engine!.talk(task);
        const report = `[智能体 "${childConfig.name}" 任务汇报]\n任务: ${task}\n结果: ${result}`;
        parentAgent.talk(report);
      } catch (err: unknown) {
        parentAgent.talk(
          `[智能体 "${childConfig.name}" 执行失败] 错误: ${(err as Error).message}`
        );
      } finally {
        this.agents.delete(childId);
        this.connections = this.connections.filter(
          (c) => c.source !== childId && c.target !== childId
        );
        console.log(
          `[System] 智能体 "${childConfig.name}" (${childId}) 已销毁。`
        );
      }
    }, 100);

    return `已创建智能体 "${childConfig.name}" (ID: ${childId})，智能体正在执行任务。完成后会自动汇报结果。你不需要再去自己完成这个任务了。等待智能体的回复即可。`;
  }

  async sendMessage(
    sourceAgentId: string,
    targetAgentId: string,
    message: string,
    context: Record<string, unknown> = {}
  ): Promise<string> {
    const sourceAgent = this.agents.get(sourceAgentId);
    const targetAgent = this.agents.get(targetAgentId);

    if (!sourceAgent)
      return `发送失败：找不到源 Agent [${sourceAgentId}]`;
    if (!targetAgent)
      return `发送失败：找不到目标 Agent [${targetAgentId}]`;

    const hasPermission = this.connections.some(
      (c) => c.source === sourceAgentId && c.target === targetAgentId
    );
    if (!hasPermission) {
      return `发送失败：你没有权限向 Agent [${targetAgent.name}] 发送消息。请检查组织架构。`;
    }

    console.log(
      `[Message Bus] ${sourceAgent.name} -> ${targetAgent.name}: ${message.substring(0, 50)}...`
    );

    const payload = {
      from: sourceAgent.name,
      from_id: sourceAgentId,
      timestamp: new Date().toISOString(),
      content: message,
      context: context,
    };

    const formattedMessage = `[消息来自： ${payload.from}] : ${payload.content}`;

    setTimeout(() => {
      targetAgent.talk(formattedMessage);
    }, 100);

    return `消息已成功发送给 ${targetAgent.name}。`;
  }

  emitEvent(event: string, data: unknown): void {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  routeMessage(
    _sourceAgentId: string,
    _message: string
  ): void {
    // 废弃：不再通过关键字隐式路由消息。
    // 所有的消息路由现在必须通过 send_message 工具显式调用。
    return;
  }

  async handleUserMessage(
    message: string,
    targetAgentId: string | null = null
  ): Promise<void> {
    if (this.agents.size === 0) {
      this.emitEvent('error', {
        message: 'No agents configured in the system.',
      });
      return;
    }

    let agent: Agent | undefined;
    if (targetAgentId) {
      agent = this.agents.get(targetAgentId);
    } else {
      agent = this.agents.values().next().value;
    }

    if (agent) {
      await agent.talk(message);
    } else {
      this.emitEvent('error', {
        message: `Agent ${targetAgentId} not found.`,
      });
    }
  }

  interruptAgent(targetAgentId: string | null = null): void {
    let agent: Agent | undefined;
    if (targetAgentId) {
      agent = this.agents.get(targetAgentId);
    } else {
      agent = this.agents.values().next().value;
    }

    if (agent && agent.engine) {
      agent.engine.interrupt();
      this.emitEvent('system_message', {
        message: `已发送中断信号给 Agent ${agent.name}`,
      });
    }
  }
}
