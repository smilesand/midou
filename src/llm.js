import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import config from '../midou.config.js';
import { getModeMaxTokens, getModeTemperature } from './mode.js';

export class LLMClient {
  constructor(options = {}) {
    this.provider = options.provider || config.llm.provider;
    this.model = options.model || config.llm.model;
    this.temperature = options.temperature !== undefined ? options.temperature : getModeTemperature();
    this.maxTokens = options.maxTokens || getModeMaxTokens();
    
    if (this.provider === 'anthropic') {
      const apiKey = options.apiKey || config.llm.anthropic.apiKey;
      if (!apiKey) throw new Error('Missing Anthropic API Key');
      this.anthropicClient = new Anthropic({
        baseURL: options.baseURL || config.llm.anthropic.baseURL,
        apiKey: apiKey,
      });
    } else {
      const apiKey = options.apiKey || config.llm.openai.apiKey;
      if (!apiKey) throw new Error('Missing OpenAI API Key');
      this.openaiClient = new OpenAI({
        baseURL: options.baseURL || config.llm.openai.baseURL,
        apiKey: apiKey,
      });
    }
  }

  extractSystem(messages) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system');
    return { system, rest };
  }

  toAnthropicMessages(messages) {
    return messages.map(m => {
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.tool_calls.map(tc => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}'),
            }))
          ]
        };
      }
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content,
            }
          ]
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  toAnthropicTools(openaiTools) {
    if (!openaiTools?.length) return undefined;
    return openaiTools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  anthropicMsgToOpenAI(msg) {
    const toolCalls = [];
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

  async chatSync(messages, tools = []) {
    if (this.provider === 'anthropic') {
      const { system, rest } = this.extractSystem(messages);
      const anthropicMessages = this.toAnthropicMessages(rest);

      const res = await this.anthropicClient.messages.create({
        model: this.model,
        system: system || undefined,
        messages: anthropicMessages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        tools: this.toAnthropicTools(tools),
      });

      return this.anthropicMsgToOpenAI(res);
    } else {
      const res = await this.openaiClient.chat.completions.create({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        tools: tools?.length > 0 ? tools : undefined,
        tool_choice: tools?.length > 0 ? 'auto' : undefined,
      });
      return res.choices[0]?.message;
    }
  }

  async *chatStreamWithTools(messages, tools) {
    if (this.provider === 'anthropic') {
      const { system, rest } = this.extractSystem(messages);
      const anthropicMessages = this.toAnthropicMessages(rest);

      const stream = this.anthropicClient.messages.stream({
        model: this.model,
        system: system || undefined,
        messages: anthropicMessages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        tools: this.toAnthropicTools(tools),
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
          case 'message_start': {
            if (event.message?.stop_reason) stopReason = event.message.stop_reason;
            break;
          }
          case 'content_block_start': {
            const block = event.content_block;
            currentBlockType = block.type;
            if (block.type === 'thinking') {
              yield { type: 'thinking_start' };
            } else if (block.type === 'tool_use') {
              currentToolId = block.id;
              currentToolName = block.name;
              currentToolJson = '';
              yield { type: 'tool_start', name: currentToolName, id: currentToolId };
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              fullText += delta.text;
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta') {
              thinkingText += delta.thinking;
              yield { type: 'thinking_delta', text: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              currentToolJson += delta.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            if (currentBlockType === 'thinking') {
              yield { type: 'thinking_end', fullText: thinkingText };
            } else if (currentBlockType === 'tool_use') {
              let inputObj = {};
              try { inputObj = JSON.parse(currentToolJson); } catch (e) {}
              toolCalls.push({
                id: currentToolId,
                type: 'function',
                function: { name: currentToolName, arguments: currentToolJson }
              });
              yield { type: 'tool_end', name: currentToolName, id: currentToolId, input: inputObj };
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

      const finalMessage = {
        role: 'assistant',
        content: fullText,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      yield { type: 'message_complete', message: finalMessage, stopReason };

    } else {
      const stream = await this.openaiClient.chat.completions.create({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        tools: tools?.length > 0 ? tools : undefined,
        stream: true,
      });

      let fullText = '';
      let thinkingText = '';
      let toolCalls = [];
      let isThinking = false;
      let stopReason = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (chunk.choices[0]?.finish_reason) {
          stopReason = chunk.choices[0].finish_reason;
        }
        if (!delta) continue;

        if (delta.reasoning_content) {
          if (!isThinking) {
            isThinking = true;
            yield { type: 'thinking_start' };
          }
          thinkingText += delta.reasoning_content;
          yield { type: 'thinking_delta', text: delta.reasoning_content };
        } else if (isThinking && !delta.reasoning_content && delta.content !== undefined) {
          isThinking = false;
          yield { type: 'thinking_end', fullText: thinkingText };
        }

        if (delta.content) {
          fullText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = {
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: '' }
              };
              yield { type: 'tool_start', name: tc.function.name, id: tc.id };
            }
            if (tc.function?.arguments) {
              toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        }
      }

      if (isThinking) {
        yield { type: 'thinking_end', fullText: thinkingText };
      }

      for (const tc of toolCalls) {
        if (tc) {
          let inputObj = {};
          try { inputObj = JSON.parse(tc.function.arguments); } catch (e) {}
          yield { type: 'tool_end', name: tc.function.name, id: tc.id, input: inputObj };
        }
      }

      const finalMessage = {
        role: 'assistant',
        content: fullText,
        tool_calls: toolCalls.length > 0 ? toolCalls.filter(Boolean) : undefined,
      };
      yield { type: 'message_complete', message: finalMessage, stopReason };
    }
  }
}

let defaultClient = null;

export function initLLM() {
  defaultClient = new LLMClient();
}

export function getProvider() {
  return {
    name: defaultClient?.provider || config.llm.provider,
    model: defaultClient?.model || config.llm.model,
  };
}

export async function chatSync(messages, tools = []) {
  if (!defaultClient) initLLM();
  return defaultClient.chatSync(messages, tools);
}

export async function* chatStreamWithTools(messages, tools) {
  if (!defaultClient) initLLM();
  yield* defaultClient.chatStreamWithTools(messages, tools);
}
