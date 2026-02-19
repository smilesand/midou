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

// ────────────────────── 公开 API ──────────────────────

/**
 * 流式对话
 */
export async function* chat(messages, options = {}) {
  if (!provider) initLLM();
  const model = options.model || config.llm.model;
  const temperature = options.temperature ?? config.llm.temperature;
  const maxTokens = options.maxTokens || config.llm.maxTokens;

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
 */
export async function chatSync(messages, options = {}) {
  if (!provider) initLLM();
  const model = options.model || config.llm.model;
  const temperature = options.temperature ?? config.llm.temperature;
  const maxTokens = options.maxTokens || config.llm.maxTokens;

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
  const temperature = options.temperature ?? config.llm.temperature;
  const maxTokens = options.maxTokens || config.llm.maxTokens;

  if (provider === 'anthropic') {
    const { system, rest } = extractSystem(messages);

    // 把 OpenAI 格式的 tool_result 转换为 Anthropic 格式
    const anthropicMessages = rest.map(m => {
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
      // 如果 assistant 消息包含 tool_calls，转换回 Anthropic 格式
      if (m.role === 'assistant' && m.tool_calls) {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        return { role: 'assistant', content };
      }
      return m;
    });

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
 * 获取当前提供商名称
 */
export function getProvider() {
  return provider || config.llm.provider;
}
