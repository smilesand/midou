/**
 * 对话引擎 — midou 思考和表达的核心
 */

import { LLMClient } from './llm.js';
import { toolDefinitions, executeTool } from './tools.js';
import { getMCPToolDefinitions } from './mcp.js';
import { SessionMemory } from './memory.js';
import type {
  OutputHandler,
  LLMConfig,
  ChatMessage,
  ToolDefinition,
  SystemManagerInterface,
} from './types.js';

const dummyOutputHandler: OutputHandler = {
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
 * 对话引擎
 */
export class ChatEngine {
  session: SessionMemory;
  turnCount: number;
  showThinking: boolean;
  lastThinking: string;
  output: OutputHandler;
  isBusy: boolean;
  isInterrupted: boolean;
  isAgentMode: boolean;
  llmClient: LLMClient;
  systemManager: SystemManagerInterface | null;
  agentId: string;
  maxIterations: number | null;

  constructor(
    systemPrompt: string,
    outputHandler: OutputHandler | null = null,
    llmConfig: LLMConfig = {},
    systemManager: SystemManagerInterface | null = null,
    isAgentMode: boolean = true,
    agentId: string = 'default',
    maxIterations: number | null = null
  ) {
    this.session = new SessionMemory();
    this.session.add('system', systemPrompt);
    this.turnCount = 0;
    this.showThinking = true;
    this.lastThinking = '';
    this.output = outputHandler || dummyOutputHandler;
    this.isBusy = false;
    this.isInterrupted = false;
    this.isAgentMode = isAgentMode;
    this.llmClient = new LLMClient(llmConfig);
    this.systemManager = systemManager;
    this.agentId = agentId;
    this.maxIterations = maxIterations;
  }

  setOutputHandler(handler: OutputHandler): void {
    this.output = handler || dummyOutputHandler;
  }

  interrupt(): void {
    this.isInterrupted = true;
  }

  _getTools(): ToolDefinition[] {
    const mcpTools = getMCPToolDefinitions();
    return [...toolDefinitions, ...mcpTools];
  }

  async talk(userMessage: string): Promise<string> {
    if (this.isBusy) {
      const busyMsg = '还在思考中，请稍等一下哦…';
      this.output.onTextDelta(busyMsg + '\n');
      return busyMsg;
    }

    this.isBusy = true;
    this.isInterrupted = false;
    try {
      this.turnCount++;
      this.session.add('user', userMessage);
      const response = await this._thinkWithTools();
      return response;
    } finally {
      this.isBusy = false;
    }
  }

  async _thinkWithTools(): Promise<string> {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let iterations = 0;
    const maxIterations =
      this.maxIterations || (this.isAgentMode ? 100 : 30);
    const tools = this._getTools();
    let isCompleted = false;

    const markComplete = (truncated: boolean = false) => {
      if (!isCompleted) {
        this.output.onTextComplete(truncated);
        isCompleted = true;
      }
    };

    while (iterations < maxIterations) {
      if (this.isInterrupted) {
        this.output.onError('任务已被用户中断。');
        markComplete(true);
        break;
      }

      iterations++;
      let completeMessage: ChatMessage | null = null;
      let iterationText = '';
      let thinkingText = '';

      try {
        for await (const event of this.llmClient.chatStreamWithTools(
          messages,
          tools
        )) {
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
              completeMessage._stopReason = event.stopReason || undefined;
              break;
          }
        }

        if (iterationText) {
          fullResponse += (fullResponse ? '\n' : '') + iterationText;
        }

        const stopReason = completeMessage?._stopReason;
        const naturalStops = [
          'end_turn',
          'stop',
          'stop_sequence',
          'tool_use',
          'tool_calls',
        ];
        const isTruncated =
          stopReason === 'max_tokens' ||
          (stopReason !== undefined &&
            !naturalStops.includes(stopReason));

        if (
          !completeMessage?.tool_calls ||
          completeMessage.tool_calls.length === 0
        ) {
          if (iterationText) {
            this.session.add('assistant', iterationText);
          }

          if (this.isAgentMode) {
            const promptMsg: ChatMessage = {
              role: 'user',
              content:
                '你没有调用任何工具。请继续执行任务。如果任务已彻底完成，请调用 finish_task 工具结束任务。',
            };
            this.session.add(promptMsg);
            messages.push(promptMsg);
            this.output.onTextDelta(
              '\n[系统提示：等待 Agent 决定下一步行动...]\n'
            );
            continue;
          } else {
            markComplete(isTruncated);
            break;
          }
        }

        if (iterationText && this.output.onTextPartComplete) {
          this.output.onTextPartComplete();
        } else if (isTruncated) {
          markComplete(true);
          break;
        }

        this.session.add(completeMessage);
        messages.push(completeMessage);

        let shouldBreakLoop = false;

        for (const tc of completeMessage.tool_calls!) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          this.output.onToolExec(tc.function.name, args);

          if (tc.function.name === 'run_command' && args.command) {
            const confirmed = await this.output.confirmCommand(
              args.command as string
            );
            if (!confirmed) {
              const rejectMsg: ChatMessage = {
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

          let result: string;
          try {
            result = await executeTool(
              tc.function.name,
              args,
              this.systemManager,
              this.agentId
            );
            this.output.onToolResult();
          } catch (e: unknown) {
            result = `工具执行出错: ${(e as Error).message}`;
            this.output.onError(
              `工具执行失败: ${(e as Error).message}`
            );
          }

          const resultMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: tc.id,
            content: String(result),
          };
          this.session.add(resultMsg);
          messages.push(resultMsg);

          if (
            tc.function.name === 'finish_task' ||
            tc.function.name === 'ask_user'
          ) {
            shouldBreakLoop = true;
          }
        }

        if (shouldBreakLoop) {
          markComplete(false);
          break;
        }

        if (isTruncated) {
          markComplete(true);
          break;
        }

        iterationText = '';
      } catch (error: unknown) {
        if (iterationText) {
          markComplete();
        }

        this.output.onError(`${(error as Error).message}，重试中…`);

        const lastMsgs = this.session.messages;
        const lastMsg = lastMsgs[lastMsgs.length - 1];
        if (lastMsg?.role === 'assistant' && lastMsg.tool_calls) {
          this.session.removeLast();
        }

        fullResponse = await this._streamResponse();
        isCompleted = true;
        break;
      }
    }

    if (!isCompleted) {
      markComplete(false);
    }

    return fullResponse;
  }

  async _streamResponse(): Promise<string> {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let stopReason: string | null = null;
    let isCompleted = false;

    try {
      for await (const event of this.llmClient.chatStreamWithTools(
        messages,
        []
      )) {
        if (event.type === 'text_delta') {
          this.output.onTextDelta(event.text);
          fullResponse += event.text;
        } else if (event.type === 'message_complete') {
          stopReason = event.stopReason;
        }
      }

      const naturalStops = ['end_turn', 'stop', 'stop_sequence'];
      const isTruncated =
        stopReason === 'max_tokens' ||
        (stopReason !== null && !naturalStops.includes(stopReason));

      this.output.onTextComplete(isTruncated);
      isCompleted = true;
      if (fullResponse) {
        this.session.add('assistant', fullResponse);
      }
    } catch (error: unknown) {
      this.output.onError(
        `重试失败: ${(error as Error).message}`
      );
    } finally {
      if (!isCompleted) {
        this.output.onTextComplete(false);
      }
    }

    return fullResponse;
  }

  updateSystemPrompt(newPrompt: string): void {
    const messages = this.session.getMessages();
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = newPrompt;
    }
  }
}
