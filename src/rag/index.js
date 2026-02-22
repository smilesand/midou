import { memorySystem } from './transformer.js';

export async function initRAG() {
  await memorySystem.init();
}

export async function addMemory(agentId, content, importance = 3, type = 'semantic') {
  return await memorySystem.addMemory(agentId, content, type, importance);
}

export async function searchMemory(agentId, query, limit = 5) {
  return await memorySystem.retrieve(agentId, query, limit);
}

export async function cleanupMemories(daysOld = 30, maxImportanceToForget = 2) {
  return await memorySystem.cleanup(daysOld, maxImportanceToForget);
}
