import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import { Agent } from './agent.js';
import { connectMCPServers, disconnectAll as disconnectMCP } from './mcp.js';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';

export class SystemManager {
  constructor(io) {
    this.io = io;
    this.agents = new Map();
    this.connections = [];
    this.cronJobs = new Map();
    this.systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
  }

  async init() {
    await this.loadSystem();
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
        if (agentConfig.data?.cronJobs && Array.isArray(agentConfig.data.cronJobs)) {
          for (const job of agentConfig.data.cronJobs) {
            if (job.expression) {
              this.setupCronJob(agent.id, job.expression, job.prompt);
            }
          }
        } else if (agentConfig.data?.cron) {
          this.setupCronJob(agent.id, agentConfig.data.cron, 'System: Scheduled activation triggered.');
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

  getOrganizationRoster() {
    if (this.agents.size === 0) return '目前组织里没有其他 Agent。';
    
    let roster = '组织花名册：\n';
    for (const [id, agent] of this.agents.entries()) {
      roster += `- [${id}] ${agent.name}: ${agent.config.systemPrompt ? agent.config.systemPrompt.slice(0, 50) + '...' : '无描述'}\n`;
    }
    return roster;
  }

  emitEvent(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  routeMessage(sourceAgentId, message) {
    // Find outgoing connections
    const outgoing = this.connections.filter(c => c.source === sourceAgentId);
    
    for (const conn of outgoing) {
      const targetAgent = this.agents.get(conn.target);
      if (!targetAgent) continue;

      // Check condition if any
      let shouldRoute = true;
      
      if (conn.data?.conditions && Array.isArray(conn.data.conditions) && conn.data.conditions.length > 0) {
        shouldRoute = false; // If there are conditions, at least one must match
        for (const cond of conn.data.conditions) {
          try {
            if (cond.type === 'contains' && cond.value) {
              if (message.includes(cond.value)) {
                shouldRoute = true;
                break;
              }
            } else if (cond.type === 'regex' && cond.value) {
              const regex = new RegExp(cond.value);
              if (regex.test(message)) {
                shouldRoute = true;
                break;
              }
            }
          } catch (e) {
            console.error(`Error evaluating condition for connection ${conn.id}:`, e);
          }
        }
      } else if (conn.data?.condition) {
        try {
          shouldRoute = message.includes(conn.data.condition);
        } catch (e) {
          console.error(`Error evaluating condition for connection ${conn.id}:`, e);
        }
      }

      if (shouldRoute) {
        console.log(`Routing message from ${sourceAgentId} to ${conn.target}`);
        // Delay slightly to avoid immediate recursion issues
        setTimeout(() => {
          targetAgent.talk(`Message from ${sourceAgentId}:\n${message}`);
        }, 100);
      }
    }
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
