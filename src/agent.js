import path from 'path';
import fs from 'fs/promises';
import { ChatEngine } from './chat.js';
import { buildSkillsPrompt } from './skills.js';
import { logConversation } from './memory.js';
import { addEpisodicMemory } from './rag/index.js';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';

export class Agent {
  constructor(config, systemManager) {
    this.id = config.id;
    this.name = config.name || 'Agent';
    this.config = config.data || config.config || {};
    this.systemManager = systemManager;
    this.workspaceDir = path.join(MIDOU_WORKSPACE_DIR, 'agents', this.name);
    this.engine = null;
    this.isBusy = false;
    this.messageQueue = [];
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
    const roster = this.systemManager.getOrganizationRoster(this.id);
    if (roster) {
      systemPrompt += `\n\n=== 组织花名册与消息路由 ===\n${roster}\n注意：你只能通过 send_message 工具向花名册中列出的 Agent 发送消息。不要在普通回复中尝试使用关键字路由。`;
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
3. **利用记忆**：如果需要更多上下文信息，请使用 \`search_memory\` 工具在 Transformer 知识库中搜索，或使用 \`read_agent_log\` 查找日志。
4. **主动记忆**：当你学到新的重要知识、完成重要任务或发现用户偏好时，主动使用 \`add_memory\` 工具将其存入 Transformer 知识库。`;
    }
    
    const llmConfig = {
      provider: this.config.provider || undefined,
      model: this.config.model || undefined,
      apiKey: this.config.apiKey || undefined,
      baseURL: this.config.baseURL || undefined,
      maxTokens: this.config.maxTokens ? parseInt(this.config.maxTokens, 10) : undefined,
    };

    const isAgentMode = this.config.isAgentMode !== false;
    const maxIterations = this.config.maxIterations ? parseInt(this.config.maxIterations, 10) : undefined;

    // Initialize ChatEngine
    this.engine = new ChatEngine(systemPrompt, null, llmConfig, this.systemManager, isAgentMode, this.id, maxIterations);
    
    // Override output handler to route messages through SystemManager
    const baseOutputHandler = this.createBaseOutputHandler();
    const finalOutputHandler = this.systemManager.buildOutputHandler ? 
      this.systemManager.buildOutputHandler(this, baseOutputHandler) : 
      baseOutputHandler;

    this.engine.setOutputHandler(finalOutputHandler);
  }

  createBaseOutputHandler() {
    return {
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
        // 废弃：不再通过关键字隐式路由消息。
        // this.systemManager.routeMessage(this.id, fullText);
      },
      onToolStart: (name) => this.systemManager.emitEvent('tool_start', { agentId: this.id, name }),
      onToolEnd: (name, input) => this.systemManager.emitEvent('tool_end', { agentId: this.id, name, input }),
      onToolExec: (name) => this.systemManager.emitEvent('tool_exec', { agentId: this.id, name }),
      onToolResult: () => this.systemManager.emitEvent('tool_result', { agentId: this.id }),
      onError: (message) => this.systemManager.emitEvent('error', { agentId: this.id, message }),
      confirmCommand: async () => true
    };
  }

  async talk(message) {
    this.messageQueue.push(message);
    this._processQueue();
  }

  async _processQueue() {
    if (this.isBusy || this.messageQueue.length === 0) return;
    
    this.isBusy = true;
    this.systemManager.emitEvent('agent_busy', { agentId: this.id });
    
    try {
      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        try {
          const response = await this.engine.talk(message);
          // 同时存储到 MD 日志和 ChromaDB
          await logConversation(this.name, message, response);
          // 将对话作为情景记忆存入 ChromaDB
          try {
            await addEpisodicMemory(this.id, message, response);
          } catch (memErr) {
            console.error(`[Agent ${this.name}] Failed to store episodic memory:`, memErr.message);
          }
        } catch (error) {
          this.systemManager.emitEvent('error', { agentId: this.id, message: error.message });
        }
      }
    } finally {
      this.isBusy = false;
      this.systemManager.emitEvent('agent_idle', { agentId: this.id });
    }
  }
}
