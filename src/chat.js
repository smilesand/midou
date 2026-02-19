/**
 * 对话引擎 — midou 思考和表达的核心
 * 
 * 支持：
 * - 流式对话输出（消除双重 API 调用）
 * - 工具调用（自我进化、记忆管理、系统命令等）
 * - MCP 扩展工具
 * - 功耗模式感知
 * - 智能会话记忆管理
 * - 多轮对话
 */

import chalk from 'chalk';
import { chat, chatStreamWithTools } from './llm.js';
import { toolDefinitions, executeTool } from './tools.js';
import { getMCPToolDefinitions } from './mcp.js';
import { SessionMemory, logConversation } from './memory.js';
import { getMode, filterToolsByMode, getJournalStrategy } from './mode.js';

/**
 * 对话引擎
 */
export class ChatEngine {
  constructor(systemPrompt) {
    this.session = new SessionMemory(50);
    this.session.add('system', systemPrompt);
    this.turnCount = 0;
    this.showThinking = true;   // 是否实时显示思考过程
    this.lastThinking = '';     // 上一次思考内容（/think 查看）
  }

  /**
   * 获取当前模式下可用的工具定义（内置 + MCP，经模式过滤）
   */
  _getTools() {
    const mcpTools = getMCPToolDefinitions();
    const all = [...toolDefinitions, ...mcpTools];
    return filterToolsByMode(all);
  }

  /**
   * 处理用户输入，返回 midou 的回复
   */
  async talk(userMessage) {
    this.turnCount++;
    this.session.add('user', userMessage);

    let response = await this._thinkWithTools();

    // 模式感知日记记录
    const strategy = getJournalStrategy();
    const logResponse = strategy.truncateResponse > 0 && response.length > strategy.truncateResponse
      ? response.slice(0, strategy.truncateResponse) + '…'
      : response;
    await logConversation(userMessage, logResponse);

    return response;
  }

  /**
   * 带工具的流式思考过程
   *
   * 全流式架构：不再用非流式 chatWithTools。
   * 所有响应（思考、文本、工具调用）都实时流式展示。
   */
  async _thinkWithTools() {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let iterations = 0;
    const maxIterations = 10;
    const tools = this._getTools();

    while (iterations < maxIterations) {
      iterations++;
      let completeMessage = null;
      let iterationText = '';
      let thinkingText = '';
      let thinkingLineCount = 0;

      try {
        for await (const event of chatStreamWithTools(messages, tools)) {
          switch (event.type) {
            // ── 思考块（支持 thinking 的模型）──
            case 'thinking_start':
              if (this.showThinking) {
                const w = Math.min(process.stdout.columns || 50, 50);
                process.stdout.write('\n' + chalk.hex('#C9B1FF')('  ┌─ 💭 ') + chalk.hex('#C9B1FF').dim('─'.repeat(Math.max(0, w - 10))) + '\n');
                process.stdout.write(chalk.hex('#C9B1FF').dim('  │ '));
              }
              break;

            case 'thinking_delta':
              thinkingText += event.text;
              if (this.showThinking) {
                const lines = event.text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (i > 0) {
                    process.stdout.write(chalk.hex('#C9B1FF').dim('\n  │ '));
                    thinkingLineCount++;
                  }
                  process.stdout.write(chalk.hex('#C9B1FF').dim(lines[i]));
                }
              }
              break;

            case 'thinking_end':
              this.lastThinking = event.fullText || thinkingText;
              if (this.showThinking && thinkingText) {
                const w = Math.min(process.stdout.columns || 50, 50);
                process.stdout.write(chalk.hex('#C9B1FF').dim(`\n  └─ ${thinkingText.length} 字 `) + chalk.hex('#C9B1FF').dim('─'.repeat(Math.max(0, w - 8 - String(thinkingText.length).length))) + '\n\n');
              } else if (thinkingText) {
                process.stdout.write(chalk.hex('#C9B1FF').dim(`  💭 ${thinkingText.length} 字 — /think 查看\n`));
              }
              break;

            // ── 正文流式输出 ──
            case 'text_delta':
              iterationText += event.text;
              process.stdout.write(chalk.hex('#FFB347')(event.text));
              break;

            // ── 工具调用 ──
            case 'tool_start': {
              const isMCP = event.name.startsWith('mcp_');
              const icon = isMCP ? '🔌' : '⚙';
              process.stdout.write(chalk.hex('#7FDBFF').dim(`\n  ${icon}  ${event.name} `));
              break;
            }

            case 'tool_end':
              process.stdout.write(chalk.hex('#7FDBFF').dim(`${JSON.stringify(event.input).slice(0, 50)}\n`));
              break;

            // ── 消息完成 ──
            case 'message_complete':
              completeMessage = event.message;
              break;
          }
        }

        // 没有工具调用 → 这是最终回复
        if (!completeMessage?.tool_calls || completeMessage.tool_calls.length === 0) {
          fullResponse = iterationText;
          if (fullResponse) {
            this.session.add('assistant', fullResponse);
          }
          process.stdout.write('\n');
          break;
        }

        // 有工具调用 → 执行工具，然后继续下一轮流式
        messages.push(completeMessage);

        for (const tc of completeMessage.tool_calls) {
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

          process.stdout.write(chalk.hex('#7FDBFF').dim(`  ↳ ${tc.function.name} `));
          const result = await executeTool(tc.function.name, args);
          process.stdout.write(chalk.green.dim('✓') + '\n');

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: String(result),
          });
        }

        // 重置本轮文本，准备下一轮流式
        iterationText = '';

      } catch (error) {
        // 失败时回退到纯流式（无工具）
        if (iterationText) {
          process.stdout.write('\n');
          console.error(chalk.yellow(`  ⚠  ${error.message}，重试中…`));
        } else {
          console.error(chalk.yellow(`  ⚠  ${error.message}`));
        }
        fullResponse = await this._streamResponse();
        break;
      }
    }

    return fullResponse;
  }

  /**
   * 流式输出回复（无工具，用于 fallback）
   */
  async _streamResponse() {
    const messages = this.session.getMessages();
    let fullResponse = '';

    for await (const chunk of chat(messages)) {
      process.stdout.write(chalk.hex('#FFB347')(chunk));
      fullResponse += chunk;
    }

    process.stdout.write('\n');
    this.session.add('assistant', fullResponse);

    return fullResponse;
  }

  /**
   * 更新系统提示词（灵魂进化 / 模式切换后需要）
   */
  updateSystemPrompt(newPrompt) {
    const messages = this.session.getMessages();
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = newPrompt;
    }
  }

  /**
   * 压缩会话历史（清除工具调用的中间消息，保留结果摘要）
   * 用于模式切换或上下文接近限制时
   */
  compressHistory() {
    const msgs = this.session.getMessages();
    const compressed = [];

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];

      // 保留 system、user、纯文本 assistant
      if (msg.role === 'system' || msg.role === 'user') {
        compressed.push(msg);
        continue;
      }

      // assistant 有 tool_calls → 跳过 tool_calls 和后续 tool results
      // 但保留 assistant 最终文本回复
      if (msg.role === 'assistant' && msg.tool_calls) {
        // 跳过这个 assistant（带 tool_calls）和后续的 tool messages
        continue;
      }

      if (msg.role === 'tool') {
        // 跳过工具结果
        continue;
      }

      // 纯文本 assistant
      compressed.push(msg);
    }

    this.session.messages = compressed;
    return compressed.length;
  }
}
