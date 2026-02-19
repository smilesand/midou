/**
 * 对话引擎 — midou 思考和表达的核心
 * 
 * 支持：
 * - 流式对话输出
 * - 工具调用（自我进化、记忆管理、系统命令等）
 * - MCP 扩展工具
 * - 会话记忆管理
 * - 多轮对话
 */

import chalk from 'chalk';
import { chat, chatWithTools } from './llm.js';
import { toolDefinitions, executeTool } from './tools.js';
import { getMCPToolDefinitions } from './mcp.js';
import { SessionMemory, logConversation } from './memory.js';

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
   * 获取合并后的所有工具定义（内置 + MCP）
   */
  _getAllTools() {
    const mcpTools = getMCPToolDefinitions();
    return [...toolDefinitions, ...mcpTools];
  }

  /**
   * 处理用户输入，返回 midou 的回复
   */
  async talk(userMessage) {
    this.turnCount++;
    this.session.add('user', userMessage);

    // 先尝试带工具的调用
    let response = await this._thinkWithTools();

    // 记录对话到日记
    await logConversation(userMessage, response);

    return response;
  }

  /**
   * 带工具的思考过程
   */
  async _thinkWithTools() {
    const messages = this.session.getMessages();
    let fullResponse = '';
    let iterations = 0;
    const maxIterations = 10; // 提高迭代上限以支持更复杂的工具链
    const allTools = this._getAllTools();

    while (iterations < maxIterations) {
      iterations++;

      try {
        const aiMessage = await chatWithTools(messages, allTools);

        // 如果没有工具调用，直接使用流式输出
        if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
          // 回退到流式输出获取更好的体验
          if (iterations === 1) {
            fullResponse = await this._streamResponse();
          } else {
            fullResponse = aiMessage.content || '';
            this.session.add('assistant', fullResponse);
            process.stdout.write(chalk.hex('#FFB347')(fullResponse));
          }
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

          // 显示工具调用信息
          const isMCP = funcName.startsWith('mcp_');
          const icon = isMCP ? '🔌' : '🔧';
          console.log(chalk.dim(`  ${icon} ${funcName}(${JSON.stringify(args).slice(0, 80)}...)`));

          const result = await executeTool(funcName, args);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: String(result),
          });
        }

        // 更新 session 消息以包含工具调用结果
        // 继续循环让模型生成最终回复
      } catch (error) {
        // 如果工具调用失败，回退到普通流式输出
        fullResponse = await this._streamResponse();
        break;
      }
    }

    return fullResponse;
  }

  /**
   * 流式输出回复
   */
  async _streamResponse() {
    const messages = this.session.getMessages();
    let fullResponse = '';

    process.stdout.write(chalk.hex('#FFB347')(''));

    for await (const chunk of chat(messages)) {
      process.stdout.write(chalk.hex('#FFB347')(chunk));
      fullResponse += chunk;
    }

    process.stdout.write('\n');
    this.session.add('assistant', fullResponse);

    return fullResponse;
  }

  /**
   * 更新系统提示词（灵魂进化后需要）
   */
  updateSystemPrompt(newPrompt) {
    const messages = this.session.getMessages();
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = newPrompt;
    }
  }
}
