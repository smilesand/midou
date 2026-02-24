import path from 'path';
import fs from 'fs/promises';
import { ChatEngine } from './chat.js';
import { buildSkillsPrompt } from './skills.js';
import { logConversation } from './memory.js';
import { addEpisodicMemory, searchMemory } from './rag/index.js';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  AgentConfig,
  AgentData,
  OutputHandler,
  LLMConfig,
  SystemManagerInterface,
} from './types.js';

export class Agent {
  id: string;
  name: string;
  config: AgentData;
  systemManager: SystemManagerInterface;
  workspaceDir: string;
  engine: ChatEngine | null;
  isBusy: boolean;
  messageQueue: string[];
  private _currentText: string;

  constructor(agentConfig: AgentConfig, systemManager: SystemManagerInterface) {
    this.id = agentConfig.id;
    this.name = agentConfig.name || 'Agent';
    this.config = agentConfig.data || agentConfig.config || {};
    this.systemManager = systemManager;
    this.workspaceDir = path.join(
      MIDOU_WORKSPACE_DIR,
      'agents',
      this.name
    );
    this.engine = null;
    this.isBusy = false;
    this.messageQueue = [];
    this._currentText = '';
  }

  async init(): Promise<void> {
    await fs.mkdir(this.workspaceDir, { recursive: true });

    let systemPrompt =
      this.config.systemPrompt ||
      `You are ${this.name}, an AI assistant.`;

    const skillsPrompt = await buildSkillsPrompt();
    if (skillsPrompt) {
      systemPrompt += `\n\n=== 你的技能 ===\n${skillsPrompt}`;
    }

    const roster = this.systemManager.getOrganizationRoster(this.id);
    if (roster) {
      systemPrompt += `\n\n=== 组织花名册 ===\n${roster}\n注意：你只能通过 send_message 工具向组织花名册中列出的其他用户发送消息。`;
    }

    try {
      const soulPath = path.join(MIDOU_WORKSPACE_DIR, 'SOUL.md');
      const soulContent = await fs.readFile(soulPath, 'utf-8');
      if (soulContent) {
        systemPrompt += `\n\n=== 核心准则 (SOUL) ===\n${soulContent}`;
      }
    } catch (_error) {
      // Ignore if SOUL.md doesn't exist
    }

    if (this.config.isAgentMode !== false) {
      systemPrompt += `\n\n=== 工作流准则 ===
1. **环境感知**：你可以通过工具获取环境信息、用户输入和记忆来感知当前情境。始终保持对上下文的敏感，确保你的行为与当前情境相关。
2. **工具优先**：在执行任何操作之前，首先考虑是否需要调用工具来获取信息、执行任务或与用户交互。工具是你完成任务的关键手段，如果没有合适的工具，就使用现有的工具来创造工具。
3. **保持专注**：始终围绕用户的目标和任务进行思考和行动。避免偏离主题或执行与当前任务无关的操作。
4. **利用记忆**：如果需要更多上下文信息，请使用 \`search_memory\` 工具在知识库中搜索，或使用 \`read_agent_log\` 查找日志。
5. **主动记忆**：当你学到新的重要知识、完成重要任务或发现用户偏好时，主动使用 \`add_memory\` 工具将其存入知识库。`;
    }

    const llmConfig: LLMConfig = {
      provider: this.config.provider || undefined,
      model: this.config.model || undefined,
      apiKey: this.config.apiKey || undefined,
      baseURL: this.config.baseURL || undefined,
      maxTokens: this.config.maxTokens
        ? parseInt(String(this.config.maxTokens), 10)
        : undefined,
    };

    try {
      const hotMemories = await searchMemory(this.id, this.name, 5);
      if (hotMemories && hotMemories.length > 0) {
        const memoryContext = hotMemories
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join('\n');
        systemPrompt += `\n\n=== 你的重要记忆 ===\n以下是你记忆中比较重要的信息，请在需要时参考：\n${memoryContext}`;
        console.log(
          `[Agent ${this.name}] 已加载 ${hotMemories.length} 条热门记忆。`
        );
      }
    } catch (err: unknown) {
      console.log(
        `[Agent ${this.name}] 加载热门记忆失败 (可能尚无记忆):`,
        (err as Error).message
      );
    }

    const isAgentMode = this.config.isAgentMode !== false;
    const maxIterations = this.config.maxIterations
      ? parseInt(String(this.config.maxIterations), 10)
      : undefined;

    this.engine = new ChatEngine(
      systemPrompt,
      null,
      llmConfig,
      this.systemManager,
      isAgentMode,
      this.id,
      maxIterations ?? null
    );

    const baseOutputHandler = this.createBaseOutputHandler();
    const finalOutputHandler = this.systemManager.buildOutputHandler
      ? this.systemManager.buildOutputHandler(this, baseOutputHandler)
      : baseOutputHandler;

    this.engine.setOutputHandler(finalOutputHandler);
  }

  createBaseOutputHandler(): OutputHandler {
    return {
      onThinkingStart: () =>
        this.systemManager.emitEvent('thinking_start', {
          agentId: this.id,
        }),
      onThinkingDelta: (text: string) =>
        this.systemManager.emitEvent('thinking_delta', {
          agentId: this.id,
          text,
        }),
      onThinkingEnd: (fullText: string) =>
        this.systemManager.emitEvent('thinking_end', {
          agentId: this.id,
          fullText,
        }),
      onThinkingHidden: (length: number) =>
        this.systemManager.emitEvent('thinking_hidden', {
          agentId: this.id,
          length,
        }),
      onTextDelta: (text: string) => {
        if (!this._currentText) this._currentText = '';
        this._currentText += text;
        this.systemManager.emitEvent('message_delta', {
          agentId: this.id,
          text,
        });
      },
      onTextPartComplete: () => {},
      onTextComplete: (truncated: boolean) => {
        const fullText = this._currentText || '';
        this.systemManager.emitEvent('message_end', {
          agentId: this.id,
          fullText,
          truncated,
        });
        this._currentText = '';
      },
      onToolStart: (name: string) =>
        this.systemManager.emitEvent('tool_start', {
          agentId: this.id,
          name,
        }),
      onToolEnd: (name: string, input: unknown) =>
        this.systemManager.emitEvent('tool_end', {
          agentId: this.id,
          name,
          input,
        }),
      onToolExec: (name: string, args: unknown) =>
        this.systemManager.emitEvent('tool_exec', {
          agentId: this.id,
          name,
          args,
        }),
      onToolResult: () =>
        this.systemManager.emitEvent('tool_result', {
          agentId: this.id,
        }),
      onError: (message: string) =>
        this.systemManager.emitEvent('error', {
          agentId: this.id,
          message,
        }),
      confirmCommand: async () => true,
    };
  }

  async talk(message: string): Promise<void> {
    this.messageQueue.push(message);
    this._processQueue();
  }

  private async _processQueue(): Promise<void> {
    if (this.isBusy || this.messageQueue.length === 0) return;

    this.isBusy = true;
    this.systemManager.emitEvent('agent_busy', { agentId: this.id });

    try {
      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift()!;
        try {
          const response = await this.engine!.talk(message);
          await logConversation(this.name, message, response);
          try {
            await addEpisodicMemory(this.id, message, response);
          } catch (memErr: unknown) {
            console.error(
              `[Agent ${this.name}] Failed to store episodic memory:`,
              (memErr as Error).message
            );
          }
        } catch (error: unknown) {
          this.systemManager.emitEvent('error', {
            agentId: this.id,
            message: (error as Error).message,
          });
        }
      }
    } finally {
      this.isBusy = false;
      this.systemManager.emitEvent('agent_idle', {
        agentId: this.id,
      });
    }
  }
}
