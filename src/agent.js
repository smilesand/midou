import path from 'path';
import fs from 'fs/promises';
import { ChatEngine } from './chat.js';
import { SessionMemory } from './memory.js';
import { buildSystemPrompt } from './soul.js';
import { buildSkillsPrompt } from './skills.js';
import { buildMCPPrompt } from './mcp.js';
import { MIDOU_COMPANY_DIR } from '../midou.config.js';

export class Agent {
  constructor(config, systemManager) {
    this.id = config.id;
    this.name = config.name || 'Agent';
    this.config = config.data || {};
    this.systemManager = systemManager;
    this.workspaceDir = path.join(MIDOU_COMPANY_DIR, 'agents', this.id);
    this.engine = null;
    this.isBusy = false;
  }

  async init() {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    
    // Build prompt based on config
    const systemPrompt = this.config.systemPrompt || `You are ${this.name}, an AI assistant.`;
    
    // Initialize ChatEngine
    this.engine = new ChatEngine(systemPrompt);
    
    // Override output handler to route messages through SystemManager
    this.engine.setOutputHandler({
      onThinkingStart: () => this.systemManager.emitEvent('thinking_start', { agentId: this.id }),
      onThinkingDelta: (text) => this.systemManager.emitEvent('thinking_delta', { agentId: this.id, text }),
      onThinkingEnd: (fullText) => this.systemManager.emitEvent('thinking_end', { agentId: this.id, fullText }),
      onThinkingHidden: (length) => this.systemManager.emitEvent('thinking_hidden', { agentId: this.id, length }),
      onTextDelta: (text) => {
        if (!this._currentText) this._currentText = '';
        this._currentText += text;
        this.systemManager.emitEvent('message_delta', { agentId: this.id, text: this._currentText });
      },
      onTextPartComplete: () => {},
      onTextComplete: (truncated) => {
        const fullText = this._currentText || '';
        this.systemManager.emitEvent('message_end', { agentId: this.id, fullText, truncated });
        this._currentText = '';
        // Trigger routing
        this.systemManager.routeMessage(this.id, fullText);
      },
      onToolStart: (name) => this.systemManager.emitEvent('tool_start', { agentId: this.id, name }),
      onToolEnd: (name, input) => this.systemManager.emitEvent('tool_end', { agentId: this.id, name, input }),
      onToolExec: (name) => this.systemManager.emitEvent('tool_exec', { agentId: this.id, name }),
      onToolResult: () => this.systemManager.emitEvent('tool_result', { agentId: this.id }),
      onError: (message) => this.systemManager.emitEvent('error', { agentId: this.id, message }),
      confirmCommand: async () => true
    });
  }

  async talk(message) {
    if (this.isBusy) return;
    this.isBusy = true;
    try {
      await this.engine.talk(message);
    } catch (error) {
      this.systemManager.emitEvent('error', { agentId: this.id, message: error.message });
    } finally {
      this.isBusy = false;
    }
  }
}
