/**
 * ChatEngine — 基于原生 SDK 的对话引擎
 *
 * 使用 llm.streamChat() 实现流式对话 + 自动工具循环。
 * ToolHalt 模式用于 finish_task / ask_user 以中断自动工具循环。
 */

import { streamChat } from './llm.js';
import { quickAsk } from './llm.js';
import {
  createCoreTools,
  executeToolByName,
  getAllToolDefinitions,
  ToolHalt,
  type ToolEntry,
  type ToolContext,
} from './tools.js';
import { getMCPToolDefinitions } from './mcp.js';
import { SessionMemory, memoryManager, logConversation, getRecentMemories } from './memory.js';
import { buildSkillsPrompt } from './skills.js';
import config from './config.js';
import type {
  AgentData,
  OutputHandler,
  ChatMessage,
  LLMConfig,
  ChatEngineInterface,
  SystemManagerInterface,
  ToolDefinition,
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
    systemManager: SystemManagerInterface | null = null,
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

    // 4. 准备工具
    const toolCtx: ToolContext = {
      systemManager: this.systemManager,
      agentId: this.agentId,
    };
    const coreTools = createCoreTools(toolCtx);
    const allToolDefs = this._getAllToolDefs(coreTools);

    // 5. 构建消息列表（不含 system，system 由 streamChat 单独处理）
    const history = this.session.getMessages().filter((m) => m.role !== 'system');

    // 6. 进入工具循环
    let fullResponse = '';
    let fullThinking = ''; // 累积所有轮次的思维链，用于持久化
    let haltMessage: string | null = null;
    let iteration = 0;
    // 用于追踪当前轮次的消息（历史 + 多轮工具调用消息）
    const conversationMessages: ChatMessage[] = [...history];

    try {
      while (iteration < this._maxIterations && !this._aborted && !haltMessage) {
        iteration++;

        // 流式调用 LLM
        const stream = streamChat(
          llmConfig,
          fullSystemPrompt,
          conversationMessages,
          allToolDefs,
          llmConfig.maxTokens,
        );

        let iterationContent = '';
        let iterationThinking = '';
        let hasToolCalls = false;
        let isThinking = false;

        for await (const chunk of stream) {
          if (this._aborted) break;

          // 文本内容
          if (chunk.content) {
            // 如果之前在 thinking 状态，先结束 thinking
            if (isThinking) {
              isThinking = false;
              this._outputHandler.onThinkingEnd(iterationThinking);
            }
            iterationContent += chunk.content;
            fullResponse += chunk.content;
            this._outputHandler.onTextDelta(chunk.content);
          }

          // 思维链
          if (chunk.thinking) {
            if (!isThinking) {
              isThinking = true;
              this._outputHandler.onThinkingStart();
            }
            iterationThinking += chunk.thinking;
            this._outputHandler.onThinkingDelta(chunk.thinking);
          }

          // 工具调用
          if (chunk.tool_calls && chunk.tool_calls.length > 0) {
            hasToolCalls = true;

            // 如果只有 thinking 输出但没有文本，发个空 delta 让前端不卡住
            if (!iterationContent) {
              this._outputHandler.onTextDelta('');
            }

            // 将 assistant 的响应（含 tool_calls）加入消息历史
            const assistantMsg: ChatMessage = {
              role: 'assistant',
              content: iterationContent,
              tool_calls: chunk.tool_calls,
            };
            conversationMessages.push(assistantMsg);

            // 逐个执行工具
            for (const tc of chunk.tool_calls) {
              const toolName = tc.function.name;
              let toolArgs: Record<string, unknown> = {};
              try {
                toolArgs = JSON.parse(tc.function.arguments || '{}');
              } catch { /* empty */ }

              this._outputHandler.onToolStart(toolName);

              const result = await executeToolByName(
                toolName,
                toolArgs,
                coreTools,
                this.systemManager,
                this.agentId,
              );

              // 检查 ToolHalt
              if (result instanceof ToolHalt) {
                haltMessage = result.content;
                this._outputHandler.onToolEnd(toolName, toolArgs);
                this._outputHandler.onToolResult();

                // 仍然需要将 tool result 加入消息（有些 API 会验证）
                conversationMessages.push({
                  role: 'tool',
                  content: result.content,
                  tool_call_id: tc.id,
                });
                break;
              }

              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

              this._outputHandler.onToolEnd(toolName, toolArgs);
              this._outputHandler.onToolExec(toolName, toolArgs);
              this._outputHandler.onToolResult();

              // 截断过长的工具结果以节省 token（完整结果已通过 OutputHandler 发送给前端）
              const MAX_TOOL_RESULT_CONTEXT = 2000;
              let contextResult = resultStr;
              if (contextResult.length > MAX_TOOL_RESULT_CONTEXT) {
                contextResult =
                  contextResult.slice(0, MAX_TOOL_RESULT_CONTEXT) +
                  `\n... [已截断，完整结果约 ${resultStr.length} 字符]`;
              }

              // 将工具结果加入消息历史
              conversationMessages.push({
                role: 'tool',
                content: contextResult,
                tool_call_id: tc.id,
              });
            }
          }
        }

        // 如果 thinking 还未结束，补发 onThinkingEnd
        if (isThinking) {
          this._outputHandler.onThinkingEnd(iterationThinking);
        }

        // 累积思维链
        if (iterationThinking) {
          fullThinking += (fullThinking ? '\n\n' : '') + iterationThinking;
        }

        // 如果没有工具调用，说明模型完成了回答，退出循环
        if (!hasToolCalls) {
          break;
        }

        // 如果有 halt，退出循环
        if (haltMessage) {
          break;
        }

        // 否则继续循环（带着工具结果让模型继续推理）
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._outputHandler.onError(`LLM 调用失败: ${errorMsg}`);
      fullResponse = `[错误] ${errorMsg}`;
    } finally {
      this._outputHandler.onTextPartComplete();
      this._outputHandler.onTextComplete(this._aborted);
    }

    // 7. 处理 halt 消息（finish_task / ask_user）
    if (haltMessage) {
      if (!fullResponse) {
        fullResponse = haltMessage.replace(/^.*ToolHalt:\s*/, '');
        this._outputHandler.onTextDelta(fullResponse);
      }
    }

    // 8. 记录到会话和日记（将思维链以 <think> 标记嵌入，前端 renderMarkdown 会转为 <details>）
    const storedResponse = fullThinking
      ? `<think>${fullThinking}</think>\n\n${fullResponse}`
      : fullResponse;
    this.session.add('assistant', storedResponse);
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

  /**
   * 合并核心工具 + MCP 工具定义
   */
  private _getAllToolDefs(coreTools: ToolEntry[]): ToolDefinition[] {
    const defs = getAllToolDefinitions(coreTools);

    // MCP 工具
    try {
      const mcpDefs = getMCPToolDefinitions();
      defs.push(...mcpDefs);
    } catch {
      // MCP 初始化可能还没完成
    }

    return defs;
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
        const memText = memories
          .map((m) => `- [${m.type}] ${m.content}`)
          .join('\n');
        parts.push(`## 长期记忆\n\n${memText}`);
      }
    } catch {
      // 长期记忆不可用
    }

    return parts.join('\n\n');
  }
}

// Re-export quickAsk for backward compatibility
export { quickAsk };
