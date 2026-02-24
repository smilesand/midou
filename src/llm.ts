/**
 * LLM 层 — 基于原生 SDK 的统一 LLM 接口
 *
 * 直接使用 @anthropic-ai/sdk 和 openai SDK，
 * 支持 Anthropic 协议（Claude / MiniMax）和 OpenAI 协议（OpenAI / DeepSeek / Moonshot 等）。
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import config from './config.js';
import type { LLMConfig, ChatMessage, ToolDefinition, ToolCall } from './types.js';

// ── 统一的流式 Chunk 类型 ──

export interface StreamChunk {
  /** 文本内容增量 */
  content?: string;
  /** 思维链增量 */
  thinking?: string;
  /** 工具调用列表（完整，仅在流结束时一次性给出） */
  tool_calls?: ToolCall[];
  /** 流结束标志 */
  done?: boolean;
  /** 停止原因 */
  stop_reason?: string;
  /** 用量统计 */
  usage?: { input_tokens: number; output_tokens: number };
}

// ── 工具定义转换 ──

/** 为 Anthropic API 格式化工具 */
function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: (t.function.parameters || { type: 'object', properties: {} }) as Anthropic.Messages.Tool.InputSchema,
  }));
}

/** 为 OpenAI API 格式化工具 */
function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description || '',
      parameters: (t.function.parameters || { type: 'object', properties: {} }) as OpenAI.FunctionParameters,
    },
  }));
}

// ── 消息格式转换 ──

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // system 由 Anthropic 的 system 参数单独处理

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // 带工具调用的 assistant 消息
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      // 工具结果消息
      result.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content || '',
        }],
      });
    } else {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content || '',
      });
    }
  }

  return result;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content || '' });
    } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      result.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      result.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content || '',
      });
    } else {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content || '',
      });
    }
  }

  return result;
}

// ═══════════════════════════════════════════
// Anthropic 流式调用
// ═══════════════════════════════════════════

async function* streamAnthropic(
  llmConfig: LLMConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const client = new Anthropic({
    apiKey: llmConfig.apiKey || config.llm.apiKey,
    baseURL: llmConfig.baseURL || config.llm.apiBase || undefined,
  });

  const requestParams: Anthropic.Messages.MessageCreateParamsStreaming = {
    model: llmConfig.model || config.llm.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: toAnthropicMessages(messages),
    stream: true,
  };

  if (tools.length > 0) {
    requestParams.tools = toAnthropicTools(tools);
  }

  const stream = client.messages.stream(requestParams, { signal });

  // 累积 tool_use blocks
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  let yieldedToolCalls = false;

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        toolCallsMap.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          arguments: '',
        });
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { content: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        yield { thinking: event.delta.thinking };
      } else if (event.delta.type === 'input_json_delta') {
        const tc = toolCallsMap.get(event.index);
        if (tc) {
          tc.arguments += event.delta.partial_json;
        }
      }
    } else if (event.type === 'message_delta') {
      const stopReason = event.delta.stop_reason;
      if ((stopReason === 'end_turn' || stopReason === 'tool_use') && toolCallsMap.size > 0) {
        const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
        yield { tool_calls: toolCalls, done: true, stop_reason: stopReason };
        yieldedToolCalls = true;
      } else if (stopReason) {
        yield { done: true, stop_reason: stopReason };
      }
      if (event.usage) {
        yield { usage: { input_tokens: 0, output_tokens: event.usage.output_tokens } };
      }
    } else if (event.type === 'message_start') {
      const msg = event.message;
      if (msg?.usage) {
        yield { usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } };
      }
    }
  }

  // Fallback: 如果有工具调用但没有通过 message_delta yield 过
  if (!yieldedToolCalls && toolCallsMap.size > 0) {
    const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
    yield { tool_calls: toolCalls, done: true, stop_reason: 'tool_use' };
  }
}

// ═══════════════════════════════════════════
// OpenAI 流式调用
// ═══════════════════════════════════════════

async function* streamOpenAI(
  llmConfig: LLMConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const client = new OpenAI({
    apiKey: llmConfig.apiKey || config.llm.apiKey,
    baseURL: llmConfig.baseURL || config.llm.apiBase || undefined,
  });

  const allMessages = toOpenAIMessages([
    { role: 'system', content: systemPrompt },
    ...messages,
  ]);

  const requestParams: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: llmConfig.model || config.llm.model,
    messages: allMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (maxTokens) {
    requestParams.max_tokens = maxTokens;
  }

  if (tools.length > 0) {
    requestParams.tools = toOpenAITools(tools);
  }

  const stream = await client.chat.completions.create(requestParams, { signal });

  // 累积 tool_calls delta
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  let yieldedToolCalls = false;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      // usage-only chunk
      if (chunk.usage) {
        yield {
          usage: {
            input_tokens: chunk.usage.prompt_tokens || 0,
            output_tokens: chunk.usage.completion_tokens || 0,
          },
        };
      }
      continue;
    }

    const delta = choice.delta;

    // 文本内容
    if (delta?.content) {
      yield { content: delta.content };
    }

    // 推理内容（部分 OpenAI 兼容 API 支持 reasoning_content）
    const deltaAny = delta as Record<string, unknown> | undefined;
    if (deltaAny?.reasoning_content) {
      yield { thinking: deltaAny.reasoning_content as string };
    }

    // 工具调用增量
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index;
        if (!toolCallsMap.has(index)) {
          toolCallsMap.set(index, {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '',
          });
        } else {
          const existing = toolCallsMap.get(index)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        }
      }
    }

    // finish_reason
    const finishReason = choice.finish_reason;
    if (finishReason === 'tool_calls' || finishReason === 'stop') {
      if (toolCallsMap.size > 0) {
        const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
        yield { tool_calls: toolCalls, done: true, stop_reason: finishReason };
        yieldedToolCalls = true;
        toolCallsMap.clear();
      } else if (finishReason === 'stop') {
        yield { done: true, stop_reason: finishReason };
      }
    }
  }

  // Fallback: 某些 API 可能不发送 finish_reason 或不发 [DONE] 就关闭连接
  if (!yieldedToolCalls && toolCallsMap.size > 0) {
    const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
    yield { tool_calls: toolCalls, done: true, stop_reason: 'tool_calls' };
  }
}

// ═══════════════════════════════════════════
// 统一对外接口
// ═══════════════════════════════════════════

/**
 * 创建流式 LLM 调用
 */
export function streamChat(
  llmConfig: LLMConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  maxTokens?: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const provider = llmConfig.provider || config.llm.provider;
  const tokens = maxTokens || llmConfig.maxTokens || config.llm.maxTokens;

  if (provider === 'anthropic') {
    return streamAnthropic(llmConfig, systemPrompt, messages, tools, tokens, signal);
  } else {
    // openai / deepseek / moonshot / zhipu / ollama 等都走 OpenAI 兼容协议
    return streamOpenAI(llmConfig, systemPrompt, messages, tools, tokens, signal);
  }
}

/**
 * 简单的同步聊天（用于 heartbeat 等内部场景）
 */
export async function quickAsk(
  prompt: string,
  systemPrompt?: string,
  llmConfig?: LLMConfig,
): Promise<string> {
  const cfg = llmConfig || {};
  const provider = cfg.provider || config.llm.provider;

  if (provider === 'anthropic') {
    const client = new Anthropic({
      apiKey: cfg.apiKey || config.llm.apiKey,
      baseURL: cfg.baseURL || config.llm.apiBase || undefined,
    });
    const response = await client.messages.create({
      model: cfg.model || config.llm.model,
      max_tokens: cfg.maxTokens || config.llm.maxTokens,
      system: systemPrompt || '',
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
    return textBlocks.map((b) => b.text).join('') || '';
  } else {
    const client = new OpenAI({
      apiKey: cfg.apiKey || config.llm.apiKey,
      baseURL: cfg.baseURL || config.llm.apiBase || undefined,
    });
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const response = await client.chat.completions.create({
      model: cfg.model || config.llm.model,
      max_tokens: cfg.maxTokens || config.llm.maxTokens,
      messages,
    });
    return response.choices[0]?.message?.content || '';
  }
}

// ── 兼容性导出 ──

export function getProvider(llmConfig?: LLMConfig): { name: string; model: string } {
  return {
    name: llmConfig?.provider || config.llm.provider,
    model: llmConfig?.model || config.llm.model,
  };
}
