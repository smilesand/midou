import path from 'path';
import fs from 'fs/promises';
import { ChatEngine } from './chat.js';
import { buildSkillsPrompt } from './skills.js';
import { logConversation } from './memory.js';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';

export class Agent {
  constructor(config, systemManager) {
    this.id = config.id;
    this.name = config.name || 'Agent';
    this.config = config.data || {};
    this.systemManager = systemManager;
    this.workspaceDir = path.join(MIDOU_WORKSPACE_DIR, 'agents', this.name);
    this.engine = null;
    this.isBusy = false;
  }

  async init() {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    
    // Build prompt based on config
    let systemPrompt = this.config.systemPrompt || `You are ${this.name}, an AI assistant.`;
    
    // Append skills if available
    const skillsPrompt = await buildSkillsPrompt();
    if (skillsPrompt) {
      systemPrompt += `\n\n=== 你的技能 ===\n${skillsPrompt}`;
    }
    
    // Append organization roster
    const roster = this.systemManager.getOrganizationRoster();
    if (roster) {
      systemPrompt += `\n\n=== 组织花名册 ===\n${roster}`;
    }
    
    // Append SOUL.md if it exists
    try {
      const soulPath = path.join(MIDOU_WORKSPACE_DIR, 'SOUL.md');
      const soulContent = await fs.readFile(soulPath, 'utf-8');
      if (soulContent) {
        systemPrompt += `\n\n=== 核心准则 (SOUL) ===\n${soulContent}`;
      }
    } catch (error) {
      // Ignore if SOUL.md doesn't exist
    }

    // Append Agent Workflow Instructions
    if (this.config.isAgentMode !== false) {
      systemPrompt += `\n\n=== Agent 工作流准则 ===
1. **测试驱动与自我验证**：当你发现需要解决一个不确定的问题时，**绝对不要**首先修改或解决用户的问题。你必须先编写相关的测试代码，进行自我验证。只有在验证通过（或多次尝试失败后），再去通知或解决用户的问题。
2. **保持专注**：在多轮对话中，请始终保持对当前任务的专注。
3. **利用记忆**：如果需要更多上下文信息，请使用 \`search_memory\` 或 \`read_agent_log\` 工具查找日志或永久记忆。`;
    }
    
    const llmConfig = {
      provider: this.config.provider || undefined,
      model: this.config.model || undefined,
      apiKey: this.config.apiKey || undefined,
      baseURL: this.config.baseURL || undefined,
    };

    const isAgentMode = this.config.isAgentMode !== false;

    // Initialize ChatEngine
    this.engine = new ChatEngine(systemPrompt, null, llmConfig, this.systemManager, isAgentMode);
    
    // Override output handler to route messages through SystemManager
    this.engine.setOutputHandler({
      onThinkingStart: () => this.systemManager.emitEvent('thinking_start', { agentId: this.id }),
      onThinkingDelta: (text) => this.systemManager.emitEvent('thinking_delta', { agentId: this.id, text }),
      onThinkingEnd: (fullText) => this.systemManager.emitEvent('thinking_end', { agentId: this.id, fullText }),
      onThinkingHidden: (length) => this.systemManager.emitEvent('thinking_hidden', { agentId: this.id, length }),
      onTextDelta: (text) => {
        if (!this._currentText) this._currentText = '';
        this._currentText += text;
        this.systemManager.emitEvent('message_delta', { agentId: this.id, text: text });
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
    this.systemManager.emitEvent('agent_busy', { agentId: this.id });
    try {
      const response = await this.engine.talk(message);
      await logConversation(this.id, this.name, message, response);
    } catch (error) {
      this.systemManager.emitEvent('error', { agentId: this.id, message: error.message });
    } finally {
      this.isBusy = false;
      this.systemManager.emitEvent('agent_idle', { agentId: this.id });
    }
  }
}
