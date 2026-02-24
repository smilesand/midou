/**
 * ChatEngine — 基于 NodeLLM 的对话引擎
 *
 * 使用 NodeLLM 的 chat.stream() + withTool() 实现流式对话和工具调用。
 * ToolHalt 模式用于 finish_task / ask_user 以中断自动工具循环。
 */

import { createMidouLLM, createChat } from './llm.js';
import type { NodeLLMInstance, NodeLLMChat } from './llm.js';
import { createCoreTools, executeTool, getLegacyTools, type ToolContext } from './tools.js';
import { SessionMemory, memoryManager, logConversation, getRecentMemories } from './memory.js';
import { buildSkillsPrompt } from './skills.js';
import { getMCPToolDefinitions } from './mcp.js';
import config from './config.js';
import type {
  AgentData,
  OutputHandler,
  ChatMessage,
  LLMConfig,
  ChatEngineInterface,
  SystemManagerInterface,
} from './types.js';

// ── 默认的 noop OutputHandler ──

const noopHandler: OutputHandler = {
  onThinkingStart: () => {},
  onThinkingDelta: () => {},
  onThinkingEnd: () => {},
  onThinkingHidden: () => {},
  onTextDelta: () => {},
  onTextPartComplete: () => {},
  onTextComplete: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onToolExec: () => {},
  onToolResult: () => {},
  onError: () => {},
  confirmCommand: async () => true,
};

/**
 * ChatEngine — 每个 Agent 拥有一个独立的引擎实例
 */
export class ChatEngine implements ChatEngineInterface {
  session: SessionMemory;
  agentId: string;
  agentName: string;
  systemPrompt: string;
  agentData: AgentData;
  systemManager: SystemManagerInterface | null;

  private _outputHandler: OutputHandler;
  private _aborted: boolean;
  private _maxIterations: number;

  constructor(
    agentId: string,
    agentName: string,
    agentData: AgentData = {},
    systemManager: SystemManagerInterface | null = null
  ) {
    this.agentId = agentId;
    this.agentName = agentName;
    this.agentData = agentData;
    this.systemPrompt = agentData.systemPrompt || '';
    this.systemManager = systemManager;
    this.session = new SessionMemory();
    this._outputHandler = { ...noopHandler };
    this._aborted = false;
    this._maxIterations = Number(agentData.maxIterations) || 20;
  }

  setOutputHandler(handler: OutputHandler): void {
    this._outputHandler = handler;
  }

  interrupt(): void {
    this._aborted = true;
  }

  /**
   * 核心对话方法 — 处理用户消息，驱动流式工具循环
   */
  async talk(userMessage: string): Promise<string> {
    this._aborted = false;

    // 1. 构建完整系统提示
    const fullSystemPrompt = await this._buildSystemPrompt();

    // 2. 记录用户消息
    this.session.add('user', userMessage);

    // 3. 获取 LLM 配置
    const llmConfig = this._getLLMConfig();

    // 4. 创建 NodeLLM 实例和 Chat
    const llm = createMidouLLM(llmConfig);
    const model = llmConfig.model || config.llm.model;
    const chat = llm.chat(model);

    // 5. 设置系统提示
    chat.system(fullSystemPrompt);

    // 6. 注入历史消息
    const history = this.session.getMessages().filter((m) => m.role !== 'system');
    // 除了最后一条（就是刚加的 user 消息），其余作为历史
    for (const msg of history.slice(0, -1)) {
      chat.add(msg.role as 'user' | 'assistant', msg.content || '');
    }

    // 7. 准备工具
    const toolCtx: ToolContext = {
      systemManager: this.systemManager,
      agentId: this.agentId,
    };
    const coreTools = createCoreTools(toolCtx);

    // 注册核心工具
    for (const tool of coreTools) {
      chat.withTool(tool);
    }

    // 注册 MCP 工具（通过 ToolDefinition 格式）
    try {
      const mcpDefs = getMCPToolDefinitions();
      for (const def of mcpDefs) {
        const mcpToolName = def.function.name;
        const toolDef = {
          type: 'function' as const,
          function: {
            name: mcpToolName,
            description: def.function.description || '',
            parameters: def.function.parameters || {},
          },
          handler: async (args: unknown) => {
            return await executeTool(mcpToolName, args as Record<string, unknown>, this.systemManager, this.agentId);
          },
        };
        chat.withTool(toolDef);
      }
    } catch {
      // MCP 初始化可能还没完成
    }

    // 8. 设置生命周期钩子
    chat.onToolCallStart((toolCall: unknown) => {
      const tc = toolCall as { function?: { name?: string } };
      this._outputHandler.onToolStart(tc?.function?.name || 'unknown');
    });

    chat.onToolCallEnd((toolCall: unknown, result: unknown) => {
      const tc = toolCall as { function?: { name?: string } };
      this._outputHandler.onToolEnd(tc?.function?.name || 'unknown', result);
      this._outputHandler.onToolResult();
    });

    // 9. 流式调用
    let fullResponse = '';
    let haltMessage: string | null = null;

    try {
      const stream = chat.stream(userMessage, {
        maxToolCalls: this._maxIterations,
      });

      for await (const chunk of stream) {
        if (this._aborted) {
          this._outputHandler.onTextComplete(true);
          break;
        }

        // ChatChunk has { content, thinking?, tool_calls?, done?, ... }
        if (chunk.content) {
          fullResponse += chunk.content;
          this._outputHandler.onTextDelta(chunk.content);
        }
        if (chunk.thinking?.text) {
          this._outputHandler.onThinkingDelta(chunk.thinking.text);
        }
      }

      this._outputHandler.onTextPartComplete();
      this._outputHandler.onTextComplete(false);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // ToolHalt 是正常的流程控制
      if (errorMsg.includes('ToolHalt') || errorMsg.includes('halt')) {
        haltMessage = errorMsg;
      } else {
        this._outputHandler.onError(`LLM 调用失败: ${errorMsg}`);
        fullResponse = `[错误] ${errorMsg}`;
      }
    }

    // 10. 处理 halt 消息（finish_task / ask_user）
    if (haltMessage) {
      if (!fullResponse) {
        fullResponse = haltMessage.replace(/^.*ToolHalt:\s*/, '');
      }
    }

    // 11. 记录到会话和日记
    this.session.add('assistant', fullResponse);
    try {
      await logConversation(this.agentName, userMessage, fullResponse);
    } catch {
      // 日记记录失败不影响主流程
    }

    return fullResponse;
  }

  // ── 内部方法 ──

  private _getLLMConfig(): LLMConfig {
    return {
      provider: this.agentData.provider || config.llm.provider,
      model: this.agentData.model || config.llm.model,
      apiKey: this.agentData.apiKey || config.llm.apiKey,
      baseURL: this.agentData.baseURL || config.llm.apiBase,
      maxTokens: Number(this.agentData.maxTokens) || config.llm.maxTokens,
    };
  }

  private async _buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    // 基础系统提示
    parts.push(this.systemPrompt || `你是 ${this.agentName}，一个有用的 AI 助手。`);

    // 技能列表
    try {
      const skillsPrompt = await buildSkillsPrompt();
      if (skillsPrompt) parts.push(skillsPrompt);
    } catch {
      // 技能模块不可用
    }

    // 最近记忆摘要
    try {
      const recentMemories = await getRecentMemories(1, this.agentName);
      if (recentMemories.trim()) {
        parts.push(`## 近期记忆\n\n${recentMemories}`);
      }
    } catch {
      // 记忆不可用
    }

    // 长期记忆
    try {
      const memories = await memoryManager.searchMemory(this.agentId, 'recent context', 3);
      if (memories.length > 0) {
        const memText = memories.map(
          (m) => `- [${m.type}] ${m.content}`
        ).join('\n');
        parts.push(`## 长期记忆\n\n${memText}`);
      }
    } catch {
      // 长期记忆不可用
    }

    return parts.join('\n\n');
  }
}
