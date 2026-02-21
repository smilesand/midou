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
import { getTodoItems } from './ui.js';

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

  onTextPartComplete() {
    process.stdout.write('\n');
  }

  onTextComplete(truncated = false) {
    process.stdout.write('\n');
    if (truncated) {
      process.stdout.write(chalk.yellow('  ⚠ 输出可能因 token 限制被截断。\n'));
      process.stdout.write(chalk.yellow('  💡 输入 "继续" 或使用 /mode full 切换到全能模式获取更长回复\n'));
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
    this.session = new SessionMemory(); // 使用默认的最大消息数 (80)
    this.session.add('system', systemPrompt);
    this.turnCount = 0;
    this.showThinking = true;
    this.lastThinking = '';
    this.output = outputHandler || new StdoutOutputHandler();
    this.isBusy = false;
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
    if (this.isBusy) {
      const busyMsg = '🐱 喵~ 咪豆还在思考中，请稍等一下哦…';
      this.output.onTextDelta(busyMsg + '\n');
      return busyMsg;
    }

    this.isBusy = true;
    try {
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
          
          // 检查是否有未完成的 TODO
          const todos = getTodoItems();
          const hasPendingTodos = todos.some(t => t.status === 'pending' || t.status === 'in_progress');
          
          if (hasPendingTodos) {
            // 如果还有未完成的 TODO，自动继续执行
            this.output.onTextDelta('\n\n{#888888-fg}[系统提示] 发现未完成的 TODO 任务，自动继续执行...{/#888888-fg}\n');
            this.session.add('user', '请继续执行 TODO 列表中的下一个任务。如果所有任务都已完成，请总结最终结果。');
            messages.push({ role: 'user', content: '请继续执行 TODO 列表中的下一个任务。如果所有任务都已完成，请总结最终结果。' });
            continue;
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
            result = await executeTool(tc.function.name, args);
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
      for await (const event of chatStreamWithTools(messages, [])) {
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
