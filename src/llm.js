/**
 * LLM 适配器 — 连接任何模型，灵魂始终是 midou 自己
 *
 * 支持的提供商（provider）：
 *   openai    → OpenAI / DeepSeek / Moonshot / 智谱 / Ollama / vLLM …
 *   anthropic → Anthropic Claude / MiniMax（推荐）…
 *
 * 通过 MIDOU_PROVIDER 环境变量切换，默认 'anthropic'
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import config from '../midou.config.js';
import { getModeMaxTokens, getModeTemperature } from './mode.js';

// ────────────────────── 内部状态 ──────────────────────

let provider = null;   // 'openai' | 'anthropic'
let openaiClient = null;
let anthropicClient = null;

// ────────────────────── 初始化 ──────────────────────

export function initLLM() {
  provider = config.llm.provider;

  if (provider === 'anthropic') {
    if (!config.llm.anthropic.apiKey) {
      throw new Error(
        '🐱 midou 需要一个 API Key 才能思考！\n' +
        '请设置环境变量 MIDOU_API_KEY 或在 .env 文件中配置'
      );
    }
    anthropicClient = new Anthropic({
      baseURL: config.llm.anthropic.baseURL,
      apiKey: config.llm.anthropic.apiKey,
    });
  } else {
    // openai 或其他兼容
    if (!config.llm.openai.apiKey) {
      throw new Error(
        '🐱 midou 需要一个 API Key 才能思考！\n' +
        '请设置环境变量 MIDOU_API_KEY 或在 .env 文件中配置'
      );
    }
    openaiClient = new OpenAI({
      baseURL: config.llm.openai.baseURL,
      apiKey: config.llm.openai.apiKey,
    });
  }
}

// ────────────────────── 工具：Anthropic ↔ OpenAI 消息格式转换 ──────────────────────

/**
 * 从标准 messages 数组中提取 system 消息（Anthropic 需要单独传）
 */
function extractSystem(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system');
  return { system, rest };
}

/**
 * 将 OpenAI 风格的 tool 定义转换为 Anthropic 格式
 */
function toAnthropicTools(openaiTools) {
  if (!openaiTools?.length) return undefined;
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * 将 Anthropic 的 tool_use 响应转成 OpenAI message 格式（让上层代码统一处理）
 */
function anthropicMsgToOpenAI(msg) {
  const toolCalls = [];
  let textContent = '';

  for (const block of msg.content) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'thinking') {
      // thinking 块也当文本输出——让 midou 可以展示思考过程
      // 不做处理，避免干扰最终回复
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    role: 'assistant',
    content: textContent || null,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

/**
 * 将 OpenAI 格式的 messages 数组转为 Anthropic 格式
 * （处理 tool / assistant+tool_calls 消息）
 */
function toAnthropicMessages(messages) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
        }],
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      return { role: 'assistant', content };
    }
    return m;
  });
}

// ────────────────────── 公开 API ──────────────────────

/**
 * 流式对话
 */
export async function* chat(messages, options = {}) {
  if (!provider) initLLM();
  const model = options.model || config.llm.model;
  const temperature = options.temperature ?? getModeTemperature();
  const maxTokens = options.maxTokens || getModeMaxTokens();

  if (provider === 'anthropic') {
    const { system, rest } = extractSystem(messages);
    const stream = anthropicClient.messages.stream({
      model,
      system: system || undefined,
      messages: rest,
      max_tokens: maxTokens,
      temperature,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } else {
    const stream = await openaiClient.chat.completions.create({
      model, messages, temperature, max_tokens: maxTokens, stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }
}

/**
 * 非流式回复（心跳 / 后台任务）
 * options.maxTokens 可由调用方（如心跳）单独指定以节省 token
 */
export async function chatSync(messages, options = {}) {
  if (!provider) initLLM();
  const model = options.model || config.llm.model;
  const temperature = options.temperature ?? getModeTemperature();
  const maxTokens = options.maxTokens || getModeMaxTokens();

  if (provider === 'anthropic') {
    const { system, rest } = extractSystem(messages);
    const res = await anthropicClient.messages.create({
      model, system: system || undefined, messages: rest,
      max_tokens: maxTokens, temperature,
    });
    // 拼接 text 块
    return res.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || '';
  } else {
    const res = await openaiClient.chat.completions.create({
      model, messages, temperature, max_tokens: maxTokens, stream: false,
    });
    return res.choices[0]?.message?.content || '';
  }
}

/**
 * 带工具调用的对话（返回统一的 OpenAI message 格式）
 */
export async function chatWithTools(messages, tools, options = {}) {
  if (!provider) initLLM();
  const model = options.model || config.llm.model;
  const temperature = options.temperature ?? getModeTemperature();
  const maxTokens = options.maxTokens || getModeMaxTokens();

  if (provider === 'anthropic') {
    const { system, rest } = extractSystem(messages);

    const anthropicMessages = toAnthropicMessages(rest);

    const res = await anthropicClient.messages.create({
      model, system: system || undefined,
      messages: anthropicMessages,
      max_tokens: maxTokens, temperature,
      tools: toAnthropicTools(tools),
    });

    // 统一转成 OpenAI 格式返回
    return anthropicMsgToOpenAI(res);
  } else {
    const res = await openaiClient.chat.completions.create({
      model, messages, temperature, max_tokens: maxTokens,
      tools, tool_choice: 'auto', stream: false,
    });
    return res.choices[0]?.message;
  }
}

/**
 * 流式对话 + 工具调用 — 返回标准化事件流
 *
 * 事件类型:
 *   thinking_start             — 思考块开始
 *   thinking_delta { text }    — 思考内容增量
 *   thinking_end { fullText }  — 思考块结束
 *   text_delta { text }        — 正文增量
 *   tool_start { name, id }    — 工具调用开始
 *   tool_end { name, id, input } — 工具调用参数完成
 *   message_complete { message, stopReason } — 整条消息完成
 */
export async function* chatStreamWithTools(messages, tools, options = {}) {
  if (!provider) initLLM();
  const model = options.model || config.llm.model;
  const temperature = options.temperature ?? getModeTemperature();
  const maxTokens = options.maxTokens || getModeMaxTokens();

  if (provider === 'anthropic') {
    const { system, rest } = extractSystem(messages);
    const anthropicMessages = toAnthropicMessages(rest);

    const stream = anthropicClient.messages.stream({
      model,
      system: system || undefined,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      temperature,
      tools: toAnthropicTools(tools),
    });

    let fullText = '';
    let thinkingText = '';
    let toolCalls = [];
    let currentBlockType = null;
    let currentToolId = '';
    let currentToolName = '';
    let currentToolJson = '';
    let stopReason = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          currentBlockType = block.type;
          if (block.type === 'thinking') {
            yield { type: 'thinking_start' };
          } else if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolJson = '';
            yield { type: 'tool_start', name: block.name, id: block.id };
          }
          break;
        }
        case 'content_block_delta': {
          const d = event.delta;
          if (d.type === 'thinking_delta') {
            thinkingText += d.thinking;
            yield { type: 'thinking_delta', text: d.thinking };
          } else if (d.type === 'text_delta') {
            fullText += d.text;
            yield { type: 'text_delta', text: d.text };
          } else if (d.type === 'input_json_delta') {
            currentToolJson += d.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          if (currentBlockType === 'thinking') {
            yield { type: 'thinking_end', fullText: thinkingText };
          } else if (currentBlockType === 'tool_use') {
            let input = {};
            try { input = JSON.parse(currentToolJson); } catch {}
            toolCalls.push({
              id: currentToolId,
              type: 'function',
              function: { name: currentToolName, arguments: currentToolJson },
            });
            yield { type: 'tool_end', name: currentToolName, id: currentToolId, input };
          }
          currentBlockType = null;
          break;
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          break;
        }
      }
    }

    yield {
      type: 'message_complete',
      message: {
        role: 'assistant',
        content: fullText || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      stopReason,
    };

  } else {
    // OpenAI provider — 流式 + 工具
    const stream = await openaiClient.chat.completions.create({
      model, messages, temperature, max_tokens: maxTokens,
      tools: tools?.length > 0 ? tools : undefined,
      tool_choice: tools?.length > 0 ? 'auto' : undefined,
      stream: true,
    });

    let fullText = '';
    let toolCallsMap = {};
    let stopReason = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        fullText += choice.delta.content;
        yield { type: 'text_delta', text: choice.delta.content };
      }

      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = { id: '', name: '', args: '' };
          }
          if (tc.id) toolCallsMap[idx].id = tc.id;
          if (tc.function?.name) {
            toolCallsMap[idx].name = tc.function.name;
            yield { type: 'tool_start', name: tc.function.name, id: tc.id || '' };
          }
          if (tc.function?.arguments) {
            toolCallsMap[idx].args += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
      }
    }

    // 输出工具完成事件并构建 toolCalls 数组
    const toolCalls = [];
    for (const tc of Object.values(toolCallsMap)) {
      let input = {};
      try { input = JSON.parse(tc.args); } catch {}
      yield { type: 'tool_end', name: tc.name, id: tc.id, input };
      toolCalls.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      });
    }

    yield {
      type: 'message_complete',
      message: {
        role: 'assistant',
        content: fullText || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      stopReason: stopReason === 'tool_calls' ? 'tool_use' : (stopReason || 'end_turn'),
    };
  }
}

/**
 * 获取当前提供商名称
 */
export function getProvider() {
  return provider || config.llm.provider;
}
