import { memorySystem } from './transformer.js';

export async function initRAG() {
  await memorySystem.init();
}

export async function addMemory(agentId, content, importance = 3, type = 'semantic') {
  return await memorySystem.addMemory(agentId, content, type, importance);
}

/**
 * 将一次对话存入 ChromaDB 作为情景记忆（episodic memory）
 */
export async function addEpisodicMemory(agentId, userMessage, assistantMessage) {
  const content = `[对话] 用户: ${userMessage}\n回复: ${assistantMessage}`;
  return await memorySystem.addMemory(agentId, content, 'episodic', 2);
}

export async function searchMemory(agentId, query, limit = 5) {
  return await memorySystem.retrieve(agentId, query, limit);
}

export async function cleanupMemories(daysOld = 30, maxImportanceToForget = 2) {
  return await memorySystem.cleanup(daysOld, maxImportanceToForget);
}

/**
 * 关闭 ChromaDB 服务器（优雅退出时调用）
 */
export async function shutdownRAG() {
  await memorySystem.shutdown();
}
