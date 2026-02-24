import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import type { LLMConfig, ChatMessage, ToolDefinition, StreamEvent } from './types.js';

export class LLMClient {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  anthropicClient?: Anthropic;
  openaiClient?: OpenAI;

  constructor(options: LLMConfig = {}) {
    this.provider = options.provider || config.llm.provider;
    this.model = options.model || config.llm.model;
    this.temperature =
      options.temperature !== undefined
        ? options.temperature
        : config.llm.temperature || 0.7;
    this.maxTokens = options.maxTokens || config.llm.maxTokens || 4096;

    if (this.provider === 'anthropic') {
      const apiKey = options.apiKey || config.llm.anthropic.apiKey;
      if (!apiKey) throw new Error('Missing Anthropic API Key');
      this.anthropicClient = new Anthropic({
        baseURL: options.baseURL || config.llm.anthropic.baseURL,
        apiKey,
      });
    } else {
      const apiKey = options.apiKey || config.llm.openai.apiKey;
      if (!apiKey) throw new Error('Missing OpenAI API Key');
      this.openaiClient = new OpenAI({
        baseURL: options.baseURL || config.llm.openai.baseURL,
        apiKey,
      });
    }
  }

  extractSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    return { system, rest };
  }

  toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.tool_calls.map((tc) => ({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
            })),
          ],
        };
      }
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: m.tool_call_id!,
              content: m.content,
            },
          ],
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    });
  }

  toAnthropicTools(openaiTools: ToolDefinition[]): Anthropic.Tool[] | undefined {
    if (!openaiTools?.length) return undefined;
    return openaiTools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  anthropicMsgToOpenAI(msg: Anthropic.Message): ChatMessage {
    const toolCalls: ChatMessage['tool_calls'] = [];
    let textContent = '';

    for (const block of msg.content) {
      if (block.type === 'text') {
        textContent += block.text;
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
      content: textContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async chatSync(
    messages: ChatMessage[],
    tools: ToolDefinition[] = []
  ): Promise<ChatMessage> {
    if (this.provider === 'anthropic') {
      const { system, rest } = this.extractSystem(messages);
      const anthropicMessages = this.toAnthropicMessages(rest);

      const res = await this.anthropicClient!.messages.create({
        model: this.model,
        system: system || undefined,
        messages: anthropicMessages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        tools: this.toAnthropicTools(tools),
      });

      return this.anthropicMsgToOpenAI(res);
    } else {
      const res = await this.openaiClient!.chat.completions.create({
        model: this.model,
        messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        tools:
          tools?.length > 0
            ? (tools as unknown as OpenAI.ChatCompletionTool[])
            : undefined,
        tool_choice: tools?.length > 0 ? 'auto' : undefined,
      });
      return res.choices[0]?.message as unknown as ChatMessage;
    }
  }

  async *chatStreamWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[]
  ): AsyncGenerator<StreamEvent> {
    if (this.provider === 'anthropic') {
      const { system, rest } = this.extractSystem(messages);
      const anthropicMessages = this.toAnthropicMessages(rest);

      const stream = this.anthropicClient!.messages.stream({
        model: this.model,
        system: system || undefined,
        messages: anthropicMessages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        tools: this.toAnthropicTools(tools),
      });

      let fullText = '';
      let thinkingText = '';
      const toolCalls: ChatMessage['tool_calls'] & object = [];
      let currentBlockType: string | null = null;
      let currentToolId = '';
      let currentToolName = '';
      let currentToolJson = '';
      let stopReason: string | null = null;

      for await (const event of stream) {
        const ev = event as unknown as Record<string, unknown>;
        switch (ev.type) {
          case 'message_start': {
            const msg = ev.message as Record<string, unknown> | undefined;
            if (msg?.stop_reason) stopReason = msg.stop_reason as string;
            break;
          }
          case 'content_block_start': {
            const block = ev.content_block as Record<string, unknown>;
            currentBlockType = block.type as string;
            if (block.type === 'thinking') {
              yield { type: 'thinking_start' };
            } else if (block.type === 'tool_use') {
              currentToolId = block.id as string;
              currentToolName = block.name as string;
              currentToolJson = '';
              yield {
                type: 'tool_start',
                name: currentToolName,
                id: currentToolId,
              };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = ev.delta as Record<string, unknown>;
            if (delta.type === 'text_delta') {
              fullText += delta.text as string;
              yield { type: 'text_delta', text: delta.text as string };
            } else if (delta.type === 'thinking_delta') {
              thinkingText += delta.thinking as string;
              yield {
                type: 'thinking_delta',
                text: delta.thinking as string,
              };
            } else if (delta.type === 'input_json_delta') {
              currentToolJson += delta.partial_json as string;
            }
            break;
          }
          case 'content_block_stop': {
            if (currentBlockType === 'thinking') {
              yield { type: 'thinking_end', fullText: thinkingText };
            } else if (currentBlockType === 'tool_use') {
              let inputObj: unknown = {};
              try {
                inputObj = JSON.parse(currentToolJson);
              } catch (_e) {
                // ignore
              }
              toolCalls.push({
                id: currentToolId,
                type: 'function',
                function: {
                  name: currentToolName,
                  arguments: currentToolJson,
                },
              });
              yield {
                type: 'tool_end',
                name: currentToolName,
                id: currentToolId,
                input: inputObj,
              };
            }
            currentBlockType = null;
            break;
          }
          case 'message_delta': {
            const d = ev.delta as Record<string, unknown> | undefined;
            if (d?.stop_reason) stopReason = d.stop_reason as string;
            break;
          }
        }
      }

      const finalMessage: ChatMessage = {
        role: 'assistant',
        content: fullText,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      yield { type: 'message_complete', message: finalMessage, stopReason };
    } else {
      const stream = await this.openaiClient!.chat.completions.create({
        model: this.model,
        messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        tools:
          tools?.length > 0
            ? (tools as unknown as OpenAI.ChatCompletionTool[])
            : undefined,
        stream: true,
      });

      let fullText = '';
      let thinkingText = '';
      const toolCalls: (ChatMessage['tool_calls'] & object)[number][] = [];
      let isThinking = false;
      let stopReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined;
        if (chunk.choices[0]?.finish_reason) {
          stopReason = chunk.choices[0].finish_reason;
        }
        if (!delta) continue;

        if (delta.reasoning_content) {
          if (!isThinking) {
            isThinking = true;
            yield { type: 'thinking_start' };
          }
          thinkingText += delta.reasoning_content as string;
          yield { type: 'thinking_delta', text: delta.reasoning_content as string };
        } else if (isThinking && !delta.reasoning_content && delta.content !== undefined) {
          isThinking = false;
          yield { type: 'thinking_end', fullText: thinkingText };
        }

        if (delta.content) {
          fullText += delta.content as string;
          yield { type: 'text_delta', text: delta.content as string };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = tc.index as number;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id as string,
                type: 'function',
                function: {
                  name: (tc.function as Record<string, unknown>)?.name as string,
                  arguments: '',
                },
              };
              yield {
                type: 'tool_start',
                name: (tc.function as Record<string, unknown>)?.name as string,
                id: tc.id as string,
              };
            }
            if ((tc.function as Record<string, unknown>)?.arguments) {
              toolCalls[idx].function.arguments +=
                (tc.function as Record<string, unknown>).arguments as string;
            }
          }
        }
      }

      if (isThinking) {
        yield { type: 'thinking_end', fullText: thinkingText };
      }

      for (const tc of toolCalls) {
        if (tc) {
          let inputObj: unknown = {};
          try {
            inputObj = JSON.parse(tc.function.arguments);
          } catch (_e) {
            // ignore
          }
          yield {
            type: 'tool_end',
            name: tc.function.name,
            id: tc.id,
            input: inputObj,
          };
        }
      }

      const finalMessage: ChatMessage = {
        role: 'assistant',
        content: fullText,
        tool_calls: toolCalls.length > 0 ? toolCalls.filter(Boolean) : undefined,
      };
      yield { type: 'message_complete', message: finalMessage, stopReason };
    }
  }
}

let defaultClient: LLMClient | null = null;

export function initLLM(): void {
  defaultClient = new LLMClient();
}

export function getProvider(): { name: string; model: string } {
  return {
    name: defaultClient?.provider || config.llm.provider,
    model: defaultClient?.model || config.llm.model,
  };
}

export async function chatSync(
  messages: ChatMessage[],
  tools: ToolDefinition[] = []
): Promise<ChatMessage> {
  if (!defaultClient) initLLM();
  return defaultClient!.chatSync(messages, tools);
}

export async function* chatStreamWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[]
): AsyncGenerator<StreamEvent> {
  if (!defaultClient) initLLM();
  yield* defaultClient!.chatStreamWithTools(messages, tools);
}
