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
import { chat, chatWithTools } from './llm.js';
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
   * 带工具的思考过程
   * 
   * 优化：使用 chatWithTools 做首次判断，如果没有工具调用
   * 直接采用其返回内容（而非重新发起流式请求），消除双重 API 调用。
   * 仅在后续轮次（工具调用后的最终回复）使用流式输出。
   */
  async _thinkWithTools() {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let iterations = 0;
    const maxIterations = 10;
    const tools = this._getTools();

    while (iterations < maxIterations) {
      iterations++;

      try {
        const aiMessage = await chatWithTools(messages, tools);

        // 没有工具调用 → 直接使用返回内容，不再重复请求
        if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
          fullResponse = aiMessage.content || '';
          this.session.add('assistant', fullResponse);
          process.stdout.write(chalk.hex('#FFB347')(fullResponse));
          process.stdout.write('\n');
          break;
        }

        // 处理工具调用
        messages.push(aiMessage);

        for (const toolCall of aiMessage.tool_calls) {
          const funcName = toolCall.function.name;
          let args;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          const isMCP = funcName.startsWith('mcp_');
          const icon = isMCP ? '🔌' : '🔧';
          console.log(chalk.dim(`  ${icon} ${funcName}(${JSON.stringify(args).slice(0, 80)}…)`));

          const result = await executeTool(funcName, args);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: String(result),
          });
        }

        // 继续循环让模型基于工具结果生成最终回复
      } catch (error) {
        // 失败时回退到流式（无工具）
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
