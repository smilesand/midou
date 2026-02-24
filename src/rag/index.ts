import { memorySystem } from './transformer.js';
import type { MemoryResult } from '../types.js';

export async function initRAG(): Promise<void> {
  await memorySystem.init();
}

export async function addMemory(
  agentId: string,
  content: string,
  importance: number = 3,
  type: string = 'semantic'
): Promise<string> {
  return await memorySystem.addMemory(agentId, content, type, importance);
}

/**
 * 将一次对话存入 ChromaDB 作为情景记忆（episodic memory）
 */
export async function addEpisodicMemory(
  agentId: string,
  userMessage: string,
  assistantMessage: string
): Promise<string> {
  const content = `[对话] 用户: ${userMessage}\n回复: ${assistantMessage}`;
  return await memorySystem.addMemory(agentId, content, 'episodic', 2);
}

export async function searchMemory(
  agentId: string,
  query: string,
  limit: number = 5
): Promise<MemoryResult[]> {
  return await memorySystem.retrieve(agentId, query, limit);
}

export async function cleanupMemories(
  daysOld: number = 30,
  maxImportanceToForget: number = 2
): Promise<number> {
  return await memorySystem.cleanup(daysOld, maxImportanceToForget);
}

/**
 * 关闭 ChromaDB 服务器（优雅退出时调用）
 */
export async function shutdownRAG(): Promise<void> {
  await memorySystem.shutdown();
}
