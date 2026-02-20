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
 * - 可插拔的输出处理器（支持 stdout / blessed UI）
 */

import chalk from 'chalk';
import { chat, chatStreamWithTools } from './llm.js';
import { toolDefinitions, executeTool } from './tools.js';
import { getMCPToolDefinitions } from './mcp.js';
import { SessionMemory, logConversation } from './memory.js';
import { filterToolsByMode, getJournalStrategy } from './mode.js';

/**
 * 默认输出处理器 — 直接写入 stdout（保持原有行为）
 */
export class StdoutOutputHandler {
  onThinkingStart() {
    const w = Math.min(process.stdout.columns || 50, 50);
    process.stdout.write('\n' + chalk.hex('#C9B1FF')('  ┌─ 💭 ') + chalk.hex('#C9B1FF').dim('─'.repeat(Math.max(0, w - 10))) + '\n');
    process.stdout.write(chalk.hex('#C9B1FF').dim('  │ '));
  }

  onThinkingDelta(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        process.stdout.write(chalk.hex('#C9B1FF').dim('\n  │ '));
      }
      process.stdout.write(chalk.hex('#C9B1FF').dim(lines[i]));
    }
  }

  onThinkingEnd(fullText) {
    if (fullText) {
      const w = Math.min(process.stdout.columns || 50, 50);
      process.stdout.write(chalk.hex('#C9B1FF').dim(`\n  └─ ${fullText.length} 字 `) + chalk.hex('#C9B1FF').dim('─'.repeat(Math.max(0, w - 8 - String(fullText.length).length))) + '\n\n');
    }
  }

  onThinkingHidden(length) {
    process.stdout.write(chalk.hex('#C9B1FF').dim(`  💭 ${length} 字 — /think 查看\n`));
  }

  onTextDelta(text) {
    process.stdout.write(chalk.hex('#FFB347')(text));
  }

  onTextComplete(truncated = false) {
    process.stdout.write('\n');
    if (truncated) {
      process.stdout.write(chalk.yellow('  ⚠ 输出因 token 限制被截断，可使用 /mode full 切换到全能模式获取更长回复\n'));
    }
  }

  onToolStart(name) {
    const isMCP = name.startsWith('mcp_');
    const icon = isMCP ? '🔌' : '⚙';
    process.stdout.write(chalk.hex('#7FDBFF').dim(`\n  ${icon}  ${name} `));
  }

  onToolEnd(name, input) {
    process.stdout.write(chalk.hex('#7FDBFF').dim(`${JSON.stringify(input).slice(0, 50)}\n`));
  }

  onToolExec(name) {
    process.stdout.write(chalk.hex('#7FDBFF').dim(`  ↳ ${name} `));
  }

  onToolResult() {
    process.stdout.write(chalk.green.dim('✓') + '\n');
  }

  onError(message) {
    console.error(chalk.yellow(`  ⚠  ${message}`));
  }

  async confirmCommand(command) {
    // readline 模式也需要用户确认命令
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      console.log('');
      console.log(chalk.yellow.bold('  ⚠ 命令确认'));
      console.log(chalk.dim('  即将执行以下命令:'));
      console.log(chalk.cyan(`  $ ${command}`));
      rl.question(chalk.dim('  确认执行? [y/N] '), (answer) => {
        rl.close();
        const confirmed = answer.trim().toLowerCase() === 'y';
        if (!confirmed) {
          console.log(chalk.dim('  已拒绝'));
        }
        resolve(confirmed);
      });
    });
  }
}

/**
 * 对话引擎
 */
export class ChatEngine {
  /**
   * @param {string} systemPrompt - 系统提示词
   * @param {object} outputHandler - 输出处理器（默认 stdout）
   */
  constructor(systemPrompt, outputHandler = null) {
    this.session = new SessionMemory(100);
    this.session.add('system', systemPrompt);
    this.turnCount = 0;
    this.showThinking = true;
    this.lastThinking = '';
    this.output = outputHandler || new StdoutOutputHandler();
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

      try {
        for await (const event of chatStreamWithTools(messages, tools)) {
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

        // 没有工具调用 → 最终回复
        if (!completeMessage?.tool_calls || completeMessage.tool_calls.length === 0) {
          fullResponse = iterationText;
          if (fullResponse) {
            this.session.add('assistant', fullResponse);
          }
          const truncated = completeMessage?._stopReason === 'max_tokens' || completeMessage?._stopReason === 'length';
          this.output.onTextComplete(truncated);
          break;
        }

        // 有工具调用 → 执行工具
        // 先清理可能存在的流式渲染器
        if (iterationText) {
          this.output.onTextComplete();
        }
        messages.push(completeMessage);

        for (const tc of completeMessage.tool_calls) {
          let args;
          try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

          this.output.onToolExec(tc.function.name);

          // 命令执行需要用户确认
          if (tc.function.name === 'run_command' && args.command) {
            const confirmed = await this.output.confirmCommand(args.command);
            if (!confirmed) {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '用户拒绝执行该命令。',
              });
              this.output.onError('命令已被用户拒绝');
              continue;
            }
          }

          const result = await executeTool(tc.function.name, args);
          this.output.onToolResult();

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: String(result),
          });
        }

        iterationText = '';

      } catch (error) {
        if (iterationText) {
          this.output.onTextComplete();
        }
        this.output.onError(`${error.message}，重试中…`);
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
      this.output.onTextDelta(chunk);
      fullResponse += chunk;
    }

    this.output.onTextComplete();
    this.session.add('assistant', fullResponse);

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

  /**
   * 压缩会话历史（清除工具调用中间消息，保留结果摘要）
   */
  compressHistory() {
    const msgs = this.session.getMessages();
    const compressed = [];

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];

      if (msg.role === 'system' || msg.role === 'user') {
        compressed.push(msg);
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        continue;
      }

      if (msg.role === 'tool') {
        continue;
      }

      compressed.push(msg);
    }

    this.session.messages = compressed;
    return compressed.length;
  }
}
