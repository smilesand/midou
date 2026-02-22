import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import { Agent } from './agent.js';
import { connectMCPServers, disconnectAll as disconnectMCP } from './mcp.js';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { initRAG, cleanupMemories } from './rag/index.js';

export class SystemManager {
  constructor(io) {
    this.io = io;
    this.agents = new Map();
    this.connections = [];
    this.cronJobs = new Map();
    this.systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
    this.outputHandlerMiddlewares = [];
  }

  useOutputHandler(middleware) {
    if (typeof middleware === 'function') {
      this.outputHandlerMiddlewares.push(middleware);
    }
  }

  buildOutputHandler(agent, baseHandler) {
    let handler = { ...baseHandler };
    for (const middleware of this.outputHandlerMiddlewares) {
      try {
        handler = middleware(agent, handler) || handler;
      } catch (err) {
        console.error(`[Plugin] Error in output handler middleware for agent ${agent.id}:`, err);
      }
    }
    return handler;
  }

  async init() {
    await initRAG();
    await this.loadSystem();
    
    // Setup daily memory cleanup (forgetting mechanism)
    cron.schedule('0 3 * * *', async () => {
      console.log('[System] Running daily memory cleanup...');
      await cleanupMemories(30, 2); // Forget memories older than 30 days with importance <= 2
    });
  }

  async loadSystem() {
    try {
      const data = await fs.readFile(this.systemPath, 'utf-8');
      const system = JSON.parse(data);
      
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
          this.setupCronJob(agent.id, agentData.cron, 'System: Scheduled activation triggered.');
        }
      }
      
      // Start global heartbeat (e.g., every 60 minutes)
      startHeartbeat(this, 60);
      
      console.log(`System loaded with ${this.agents.size} agents and ${this.connections.length} connections.`);
    } catch (error) {
      console.log('No system.json found or error parsing, starting empty system.', error);
      this.agents.clear();
      this.connections = [];
    }
  }

  setupCronJob(agentId, cronExpression, prompt) {
    if (!cron.validate(cronExpression)) {
      console.error(`Invalid cron expression for agent ${agentId}: ${cronExpression}`);
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
    this.cronJobs.get(agentId).push(job);
  }

  stopAllCronJobs() {
    for (const jobs of this.cronJobs.values()) {
      for (const job of jobs) {
        job.stop();
      }
    }
    this.cronJobs.clear();
  }

  getOrganizationRoster(requestingAgentId = null) {
    if (this.agents.size === 0) return '目前组织里没有其他 Agent。';
    
    let roster = '组织花名册：\n';
    
    if (requestingAgentId) {
      // 只能看到自己有权限通讯的 Agent（即有连线指向的 Agent）
      const outgoing = this.connections.filter(c => c.source === requestingAgentId);
      if (outgoing.length > 0) {
        roster += '你可以通过 send_message 工具向以下 Agent 发送消息：\n';
        for (const conn of outgoing) {
          const targetAgent = this.agents.get(conn.target);
          if (!targetAgent) continue;
          
          roster += `- [${targetAgent.id}] ${targetAgent.name}: ${targetAgent.config.systemPrompt ? targetAgent.config.systemPrompt.slice(0, 100) + '...' : '无描述'}\n`;
        }
      } else {
        roster += '你当前没有权限向任何其他 Agent 发送消息。\n';
      }
    } else {
      // 如果没有指定请求者，返回所有 Agent（通常是系统管理员视角）
      for (const [id, agent] of this.agents.entries()) {
        roster += `- [${id}] ${agent.name}: ${agent.config.systemPrompt ? agent.config.systemPrompt.slice(0, 50) + '...' : '无描述'}\n`;
      }
    }

    return roster;
  }

  async sendMessage(sourceAgentId, targetAgentId, message, context = {}) {
    const sourceAgent = this.agents.get(sourceAgentId);
    const targetAgent = this.agents.get(targetAgentId);

    if (!sourceAgent) return `发送失败：找不到源 Agent [${sourceAgentId}]`;
    if (!targetAgent) return `发送失败：找不到目标 Agent [${targetAgentId}]`;

    // 检查权限（是否有从 source 到 target 的连线）
    const hasPermission = this.connections.some(c => c.source === sourceAgentId && c.target === targetAgentId);
    if (!hasPermission) {
      return `发送失败：你没有权限向 Agent [${targetAgent.name}] 发送消息。请检查组织架构。`;
    }

    console.log(`[Message Bus] ${sourceAgent.name} -> ${targetAgent.name}: ${message.substring(0, 50)}...`);
    
    // 构造标准化的消息结构
    const payload = {
      from: sourceAgent.name,
      from_id: sourceAgentId,
      timestamp: new Date().toISOString(),
      content: message,
      context: context
    };

    const formattedMessage = `[来自 ${payload.from} 的内部消息]:\n${payload.content}\n\n(附加信息: ${JSON.stringify(payload.context)})`;

    // 异步发送，不阻塞当前 Agent
    setTimeout(() => {
      targetAgent.talk(formattedMessage);
    }, 100);

    return `消息已成功发送给 ${targetAgent.name}。`;
  }

  emitEvent(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  routeMessage(sourceAgentId, message) {
    // 废弃：不再通过关键字隐式路由消息。
    // 所有的消息路由现在必须通过 send_message 工具显式调用。
    return;
  }

  async handleUserMessage(message, targetAgentId = null) {
    if (this.agents.size === 0) {
      this.emitEvent('error', { message: 'No agents configured in the system.' });
      return;
    }

    // If no target specified, send to the first agent (or a designated "entry" agent)
    let agent = null;
    if (targetAgentId) {
      agent = this.agents.get(targetAgentId);
    } else {
      // Just pick the first one
      agent = this.agents.values().next().value;
    }

    if (agent) {
      await agent.talk(message);
    } else {
      this.emitEvent('error', { message: `Agent ${targetAgentId} not found.` });
    }
  }

  interruptAgent(targetAgentId = null) {
    let agent = null;
    if (targetAgentId) {
      agent = this.agents.get(targetAgentId);
    } else {
      agent = this.agents.values().next().value;
    }

    if (agent && agent.engine) {
      agent.engine.interrupt();
      this.emitEvent('system_message', { message: `已发送中断信号给 Agent ${agent.name}` });
    }
  }
}
