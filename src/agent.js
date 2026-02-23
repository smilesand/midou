import path from 'path';
import fs from 'fs/promises';
import { ChatEngine } from './chat.js';
import { buildSkillsPrompt } from './skills.js';
import { logConversation } from './memory.js';
import { addEpisodicMemory, searchMemory } from './rag/index.js';
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
      systemPrompt += `\n\n=== 组织花名册 ===\n${roster}\n注意：你只能通过 send_message 工具向组织花名册中列出的其他用户发送消息。`;
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
      systemPrompt += `\n\n=== 工作流准则 ===
1. **环境感知**：你可以通过工具获取环境信息、用户输入和记忆来感知当前情境。始终保持对上下文的敏感，确保你的行为与当前情境相关。
2. **工具优先**：在执行任何操作之前，首先考虑是否需要调用工具来获取信息、执行任务或与用户交互。工具是你完成任务的关键手段，如果没有合适的工具，就使用现有的工具来创造工具。
3. **保持专注**：始终围绕用户的目标和任务进行思考和行动。避免偏离主题或执行与当前任务无关的操作。
4. **利用记忆**：如果需要更多上下文信息，请使用 \`search_memory\` 工具在知识库中搜索，或使用 \`read_agent_log\` 查找日志。
5. **主动记忆**：当你学到新的重要知识、完成重要任务或发现用户偏好时，主动使用 \`add_memory\` 工具将其存入知识库。`;
    }
    
    const llmConfig = {
      provider: this.config.provider || undefined,
      model: this.config.model || undefined,
      apiKey: this.config.apiKey || undefined,
      baseURL: this.config.baseURL || undefined,
      maxTokens: this.config.maxTokens ? parseInt(this.config.maxTokens, 10) : undefined,
    };

    // 从记忆系统加载热门记忆作为初始上下文
    try {
      const hotMemories = await searchMemory(this.id, this.name, 5);
      if (hotMemories && hotMemories.length > 0) {
        const memoryContext = hotMemories
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join('\n');
        systemPrompt += `\n\n=== 你的重要记忆 ===\n以下是你记忆中比较重要的信息，请在需要时参考：\n${memoryContext}`;
        console.log(`[Agent ${this.name}] 已加载 ${hotMemories.length} 条热门记忆。`);
      }
    } catch (err) {
      console.log(`[Agent ${this.name}] 加载热门记忆失败 (可能尚无记忆):`, err.message);
    }

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
