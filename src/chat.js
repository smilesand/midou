/**
 * 对话引擎 — midou 思考和表达的核心
 * 
 * 支持：
 * - 流式对话输出（消除双重 API 调用）
 * - 工具调用（自我进化、记忆管理、系统命令等）
 * - MCP 扩展工具
 * - 功耗模式感知
 * - 智能会话记忆管理（带上下文摘要）
 * - 多轮对话
 * - 可插拔的输出处理器
 */

import { LLMClient } from './llm.js';
import { toolDefinitions, executeTool } from './tools.js';
import { getMCPToolDefinitions } from './mcp.js';
import { SessionMemory } from './memory.js';

const dummyOutputHandler = {
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
  confirmCommand: async () => true
};

/**
 * 对话引擎
 */
export class ChatEngine {
  /**
   * @param {string} systemPrompt - 系统提示词
   * @param {object} outputHandler - 输出处理器
   * @param {object} llmConfig - LLM 配置
   * @param {object} systemManager - 系统管理器
   */
  constructor(systemPrompt, outputHandler = null, llmConfig = {}, systemManager = null) {
    this.session = new SessionMemory(); // 使用默认的最大消息数 (80)
    this.session.add('system', systemPrompt);
    this.turnCount = 0;
    this.showThinking = true;
    this.lastThinking = '';
    this.output = outputHandler || dummyOutputHandler;
    this.isBusy = false;
    this.llmClient = new LLMClient(llmConfig);
    this.systemManager = systemManager;
  }

  setOutputHandler(handler) {
    this.output = handler || dummyOutputHandler;
  }

  /**
   * 获取当前模式下可用的工具定义（内置 + MCP，经模式过滤）
   */
  _getTools() {
    const mcpTools = getMCPToolDefinitions();
    return [...toolDefinitions, ...mcpTools];
  }

  /**
   * 处理用户输入，返回 midou 的回复
   */
  async talk(userMessage) {
    if (this.isBusy) {
      const busyMsg = '还在思考中，请稍等一下哦…';
      this.output.onTextDelta(busyMsg + '\n');
      return busyMsg;
    }

    this.isBusy = true;
    try {
      this.turnCount++;
      this.session.add('user', userMessage);

      let response = await this._thinkWithTools();

      return response;
    } finally {
      this.isBusy = false;
    }
  }

  /**
   * 带工具的流式思考过程
   */
  async _thinkWithTools() {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let iterations = 0;
    const maxIterations = 30; // 增加最大迭代次数以支持长 TODO 流程
    const tools = this._getTools();
    let isCompleted = false;

    const markComplete = (truncated = false) => {
      if (!isCompleted) {
        this.output.onTextComplete(truncated);
        isCompleted = true;
      }
    };

    while (iterations < maxIterations) {
      iterations++;
      let completeMessage = null;
      let iterationText = '';
      let thinkingText = '';

      try {
        for await (const event of this.llmClient.chatStreamWithTools(messages, tools)) {
          switch (event.type) {
            case 'thinking_start':
              if (this.showThinking) {
                this.output.onThinkingStart();
              }
              break;

            case 'thinking_delta':
              thinkingText += event.text;
              if (this.showThinking) {
                this.output.onThinkingDelta(event.text);
              }
              break;

            case 'thinking_end':
              this.lastThinking = event.fullText || thinkingText;
              if (this.showThinking && thinkingText) {
                this.output.onThinkingEnd(thinkingText);
              } else if (thinkingText) {
                this.output.onThinkingHidden(thinkingText.length);
              }
              break;

            case 'text_delta':
              iterationText += event.text;
              this.output.onTextDelta(event.text);
              break;

            case 'tool_start':
              this.output.onToolStart(event.name);
              break;

            case 'tool_end':
              this.output.onToolEnd(event.name, event.input);
              break;

            case 'message_complete':
              completeMessage = event.message;
              completeMessage._stopReason = event.stopReason;
              break;
          }
        }

        // 累计本轮文本到总回复
        if (iterationText) {
          fullResponse += (fullResponse ? '\n' : '') + iterationText;
        }

        // 检查截断：除了自然的结束和工具调用外，都视为截断
        const stopReason = completeMessage?._stopReason;
        const naturalStops = ['end_turn', 'stop', 'stop_sequence', 'tool_use', 'tool_calls'];
        const isTruncated = stopReason === 'max_tokens' || (stopReason && !naturalStops.includes(stopReason));

        // 没有工具调用 → 最终回复
        if (!completeMessage?.tool_calls || completeMessage.tool_calls.length === 0) {
          if (iterationText) {
            this.session.add('assistant', iterationText);
          }
          
          markComplete(isTruncated);
          break;
        }

        // 有工具调用 → 执行工具
        // 如果有中间文本，先通知输出处理器（但不标记为最终完成）
        if (iterationText && this.output.onTextPartComplete) {
          this.output.onTextPartComplete();
        } else if (isTruncated) {
          // 如果在工具调用前就被截断了，不得不标记完成
          markComplete(true);
          break;
        }
        
        // 将带工具调用的回复添加到 session，确保历史完整
        this.session.add(completeMessage);
        messages.push(completeMessage);

        for (const tc of completeMessage.tool_calls) {
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

          this.output.onToolExec(tc.function.name);

          // 命令执行需要用户确认
          if (tc.function.name === 'run_command' && args.command) {
            const confirmed = await this.output.confirmCommand(args.command);
            if (!confirmed) {
              const rejectMsg = {
                role: 'tool',
                tool_call_id: tc.id,
                content: '用户拒绝执行该命令。',
              };
              this.session.add(rejectMsg);
              messages.push(rejectMsg);
              this.output.onError('命令已被用户拒绝');
              continue;
            }
          }

          let result;
          try {
            result = await executeTool(tc.function.name, args, this.systemManager);
            this.output.onToolResult();
          } catch (e) {
            result = `工具执行出错: ${e.message}`;
            this.output.onError(`工具执行失败: ${e.message}`);
          }

          const resultMsg = {
            role: 'tool',
            tool_call_id: tc.id,
            content: String(result),
          };
          this.session.add(resultMsg);
          messages.push(resultMsg);
        }

        // 如果本轮已经因为 token 限制截断了，且后面还要继续（工具调用后通常会继续），
        // 最好在这里中断，或者提醒用户。
        if (isTruncated) {
          markComplete(true);
          break;
        }

        iterationText = '';

      } catch (error) {
        if (iterationText) {
          markComplete();
        }
        
        this.output.onError(`${error.message}，重试中…`);

        // 重要：检查最后一条消息是否是未完成的工具调用
        const lastMsgs = this.session.messages;
        const lastMsg = lastMsgs[lastMsgs.length - 1];
        if (lastMsg?.role === 'assistant' && lastMsg.tool_calls) {
          // 如果最后一条是工具调用但发生了异常（可能是工具不存在或解析错误），
          // 移除它以避免后续请求因缺失 tool 消息而报错 400
          this.session.removeLast();
        }

        fullResponse = await this._streamResponse();
        isCompleted = true; // _streamResponse handles its own completion
        break;
      }
    }

    if (!isCompleted) {
      markComplete(false);
    }

    return fullResponse;
  }

  /**
   * 流式输出回复（无工具，用于 fallback）
   */
  async _streamResponse() {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let stopReason = null;
    let isCompleted = false;

    try {
      for await (const event of this.llmClient.chatStreamWithTools(messages, [])) {
        if (event.type === 'text_delta') {
          this.output.onTextDelta(event.text);
          fullResponse += event.text;
        } else if (event.type === 'message_complete') {
          stopReason = event.stopReason;
        }
      }

      const naturalStops = ['end_turn', 'stop', 'stop_sequence'];
      const isTruncated = stopReason === 'max_tokens' || (stopReason && !naturalStops.includes(stopReason));
      
      this.output.onTextComplete(isTruncated);
      isCompleted = true;
      if (fullResponse) {
        this.session.add('assistant', fullResponse);
      }
    } catch (error) {
      this.output.onError(`重试失败: ${error.message}`);
    } finally {
      if (!isCompleted) {
        this.output.onTextComplete(false);
      }
    }

    return fullResponse;
  }

  /**
   * 更新系统提示词
   */
  updateSystemPrompt(newPrompt) {
    const messages = this.session.getMessages();
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = newPrompt;
    }
  }
}
