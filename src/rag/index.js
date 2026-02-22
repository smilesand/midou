import { pipeline } from '@xenova/transformers';
import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from '../../midou.config.js';

let embedder = null;
let memoryStore = [];
const MEMORY_FILE = path.join(MIDOU_WORKSPACE_DIR, 'rag_memory.json');

// Cosine similarity function
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function initRAG() {
  try {
    // Initialize the embedding model (runs locally)
    if (!embedder) {
      console.log('[RAG] Loading transformer model for embeddings...');
      embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log('[RAG] Transformer model loaded.');
    }

    // Load existing memories
    try {
      const data = await fs.readFile(MEMORY_FILE, 'utf-8');
      memoryStore = JSON.parse(data);
      console.log(`[RAG] Loaded ${memoryStore.length} memories from disk.`);
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('[RAG] No existing memory file found, starting fresh.');
        memoryStore = [];
      } else {
        console.error('[RAG] Error loading memory file:', e);
      }
    }
  } catch (error) {
    console.error('[RAG] Failed to initialize RAG system:', error);
  }
}

async function saveMemories() {
  try {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    await fs.writeFile(MEMORY_FILE, JSON.stringify(memoryStore, null, 2), 'utf-8');
  } catch (e) {
    console.error('[RAG] Failed to save memories to disk:', e);
  }
}

async function getEmbedding(text) {
  if (!embedder) await initRAG();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function addMemory(agentId, content, importance = 3) {
  if (!embedder) await initRAG();
  
  const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const embedding = await getEmbedding(content);
  
  memoryStore.push({
    id,
    agentId: agentId || 'system',
    content,
    embedding,
    metadata: {
      timestamp: Date.now(),
      importance: importance, // 1-5 scale
      accessCount: 0,
      lastAccessed: Date.now()
    }
  });
  
  await saveMemories();
  console.log(`[RAG] Added memory for ${agentId || 'system'}: ${content.substring(0, 30)}...`);
  return id;
}

export async function searchMemory(agentId, query, limit = 5) {
  if (!embedder) await initRAG();
  if (memoryStore.length === 0) return [];
  
  const queryEmbedding = await getEmbedding(query);
  
  // Calculate similarities
  const results = memoryStore
    .filter(m => !agentId || m.agentId === agentId)
    .map(m => ({
      ...m,
      similarity: cosineSimilarity(queryEmbedding, m.embedding)
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  // Update access metadata for forgetting mechanism
  let needsSave = false;
  for (const result of results) {
    const mem = memoryStore.find(m => m.id === result.id);
    if (mem) {
      mem.metadata.accessCount = (mem.metadata.accessCount || 0) + 1;
      mem.metadata.lastAccessed = Date.now();
      needsSave = true;
    }
  }
  
  if (needsSave) {
    await saveMemories();
  }

  return results.map(r => ({
    content: r.content,
    distance: 1 - r.similarity, // Convert similarity to distance for backwards compatibility
    metadata: r.metadata
  }));
}

/**
 * Forgetting Mechanism:
 * Removes memories that haven't been accessed recently and have low importance.
 */
export async function cleanupMemories(daysOld = 30, maxImportanceToForget = 2) {
  if (memoryStore.length === 0) return 0;
  
  const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
  const initialLength = memoryStore.length;
  
  memoryStore = memoryStore.filter(m => {
    const isOld = m.metadata.lastAccessed < cutoffTime;
    const isUnimportant = m.metadata.importance <= maxImportanceToForget;
    // Keep if it's NOT (old AND unimportant)
    return !(isOld && isUnimportant);
  });
  
  const deletedCount = initialLength - memoryStore.length;
  
  if (deletedCount > 0) {
    await saveMemories();
    console.log(`[RAG] Forgot ${deletedCount} old/unimportant memories.`);
  }
  
  return deletedCount;
}
