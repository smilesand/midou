import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import { Agent } from './agent.js';
import { MIDOU_COMPANY_DIR } from '../midou.config.js';

export class SystemManager {
  constructor(io) {
    this.io = io;
    this.agents = new Map();
    this.connections = [];
    this.cronJobs = new Map();
    this.systemPath = path.join(MIDOU_COMPANY_DIR, 'system.json');
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
      this.agents.clear();
      this.connections = system.connections || [];

      // Initialize agents
      for (const agentConfig of system.agents || []) {
        const agent = new Agent(agentConfig, this);
        await agent.init();
        this.agents.set(agent.id, agent);

        // Setup cron if configured
        if (agentConfig.data?.cron) {
          this.setupCronJob(agent.id, agentConfig.data.cron);
        }
      }
      console.log(`System loaded with ${this.agents.size} agents and ${this.connections.length} connections.`);
    } catch (error) {
      console.log('No system.json found or error parsing, starting empty system.');
      this.agents.clear();
      this.connections = [];
    }
  }

  setupCronJob(agentId, cronExpression) {
    if (!cron.validate(cronExpression)) {
      console.error(`Invalid cron expression for agent ${agentId}: ${cronExpression}`);
      return;
    }

    const job = cron.schedule(cronExpression, () => {
      const agent = this.agents.get(agentId);
      if (agent) {
        console.log(`[Cron] Triggering agent ${agentId}`);
        agent.talk('System: Scheduled activation triggered.');
      }
    });

    this.cronJobs.set(agentId, job);
  }

  stopAllCronJobs() {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
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
      if (conn.data?.condition) {
        try {
          // Simple condition evaluation: check if message contains the condition string
          // In a real system, this could be a regex or an LLM evaluation
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
}
