/**
 * LLM 层 — 基于 NodeLLM 的统一 LLM 接口
 *
 * 使用 @node-llm/core 实现 Provider 无关的 LLM 调用，
 * 支持 OpenAI、Anthropic、Gemini、DeepSeek 等所有 NodeLLM 支持的提供者。
 */

import { createLLM } from '@node-llm/core';
import config from './config.js';
import type { LLMConfig } from './types.js';

// NodeLLM 类型（由于库未导出完整类型，此处定义必要的接口）
export type NodeLLMInstance = ReturnType<typeof createLLM>;
export type NodeLLMChat = ReturnType<NodeLLMInstance['chat']>;

/**
 * 根据 midou 配置创建 NodeLLM 实例
 */
export function createMidouLLM(options: LLMConfig = {}): NodeLLMInstance {
  const provider = options.provider || config.llm.provider;
  const apiKey = options.apiKey || config.llm.apiKey;
  const apiBase = options.baseURL || config.llm.apiBase;

  const llmConfig: Record<string, unknown> = {
    provider,
    maxTokens: options.maxTokens || config.llm.maxTokens,
    requestTimeout: 120000,
    maxRetries: 2,
  };

  // 根据 provider 设置对应的 API Key 和 Base URL
  if (provider === 'anthropic') {
    if (apiKey) llmConfig.anthropicApiKey = apiKey;
    if (apiBase) llmConfig.anthropicApiBase = apiBase;
  } else if (provider === 'openai') {
    if (apiKey) llmConfig.openaiApiKey = apiKey;
    if (apiBase) llmConfig.openaiApiBase = apiBase;
  } else if (provider === 'gemini') {
    if (apiKey) llmConfig.geminiApiKey = apiKey;
    if (apiBase) llmConfig.geminiApiBase = apiBase;
  } else if (provider === 'deepseek') {
    if (apiKey) llmConfig.deepseekApiKey = apiKey;
    if (apiBase) llmConfig.deepseekApiBase = apiBase;
  } else if (provider === 'openrouter') {
    if (apiKey) llmConfig.openrouterApiKey = apiKey;
    if (apiBase) llmConfig.openrouterApiBase = apiBase;
  } else {
    // 默认当作 openai 兼容
    if (apiKey) llmConfig.openaiApiKey = apiKey;
    if (apiBase) llmConfig.openaiApiBase = apiBase;
  }

  return createLLM(llmConfig);
}

/**
 * 创建 NodeLLM Chat 实例
 */
export function createChat(
  llm: NodeLLMInstance,
  model?: string,
  systemPrompt?: string
): NodeLLMChat {
  const m = model || config.llm.model;
  const chat = llm.chat(m);
  if (systemPrompt) {
    chat.system(systemPrompt);
  }
  return chat;
}

/**
 * 简单的同步聊天（用于 heartbeat 等内部场景）
 */
export async function quickAsk(
  prompt: string,
  systemPrompt?: string,
  llmConfig?: LLMConfig
): Promise<string> {
  const llm = createMidouLLM(llmConfig);
  const model = llmConfig?.model || config.llm.model;
  const chat = llm.chat(model);
  if (systemPrompt) {
    chat.system(systemPrompt);
  }
  const response = await chat.ask(prompt);
  return typeof response === 'string' ? response : String(response.content ?? response);
}

// ── 兼容性导出 ──

export function getProvider(llmConfig?: LLMConfig): { name: string; model: string } {
  return {
    name: llmConfig?.provider || config.llm.provider,
    model: llmConfig?.model || config.llm.model,
  };
}
