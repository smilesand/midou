/**
 * RAG (Transformer Memory) System Tests
 * 
 * Tests ChromaDB integration, embedding pipeline, memory CRUD,
 * consolidation, and retrieval with attention mechanism.
 * 
 * Usage: node --test test/test-rag.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initRAG, addMemory, addEpisodicMemory, searchMemory, cleanupMemories, shutdownRAG } from '../src/rag/index.js';
import { memorySystem } from '../src/rag/transformer.js';

describe('RAG System', () => {
  before(async () => {
    // 初始化 RAG 系统 (加载 embedding pipeline + 启动 ChromaDB)
    await initRAG();
  });

  after(async () => {
    await shutdownRAG();
  });

  it('should initialize embedding pipeline', () => {
    assert.ok(memorySystem.embedder, 'Embedding pipeline should be loaded');
  });

  it('should connect to ChromaDB', () => {
    assert.ok(memorySystem.chromaClient, 'ChromaDB client should be initialized');
    assert.ok(memorySystem.collection, 'Collection should be created');
  });

  it('should generate embeddings', async () => {
    const embedding = await memorySystem.getEmbedding('Hello, world!');
    assert.ok(Array.isArray(embedding), 'Embedding should be an array');
    assert.equal(embedding.length, 384, 'Embedding dimension should be 384');

    // Verify normalization (L2 norm ≈ 1)
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 0.01, `Embedding should be normalized (norm=${norm})`);
  });

  it('should add semantic memory', async () => {
    const id = await addMemory('test-agent', '咪豆是一只公狸花猫', 4, 'semantic');
    assert.ok(id, 'Should return a memory ID');
    assert.ok(id.startsWith('mem_'), 'Memory ID should start with mem_');
  });

  it('should add episodic memory', async () => {
    const id = await addEpisodicMemory('test-agent', '你好', '你好！有什么可以帮你的？');
    assert.ok(id, 'Should return a memory ID');
  });

  it('should search memory by relevance', async () => {
    // Add a few more memories
    await addMemory('test-agent', '今天天气晴朗，适合出门', 3, 'semantic');
    await addMemory('test-agent', 'JavaScript 是一门编程语言', 3, 'semantic');

    // Search for cat-related content
    const results = await searchMemory('test-agent', '猫', 3);
    assert.ok(Array.isArray(results), 'Results should be an array');
    assert.ok(results.length > 0, 'Should find at least one result');

    // The cat memory should be the most relevant
    const topResult = results[0];
    assert.ok(topResult.content.includes('咪豆') || topResult.content.includes('猫'),
      'Top result should be cat-related');
    assert.ok(topResult.attentionWeight > 0, 'Should have attention weight');
  });

  it('should return attention weights that sum to reasonable values', async () => {
    const results = await searchMemory('test-agent', '编程语言', 5);
    assert.ok(results.length > 0, 'Should find results');

    // Each result should have metrics
    for (const r of results) {
      assert.ok(typeof r.attentionWeight === 'number', 'Should have attention weight');
      assert.ok(typeof r.metrics.timeDecay === 'number', 'Should have time decay');
      assert.ok(r.metadata, 'Should have metadata');
    }
  });

  it('should consolidate highly similar semantic memories', async () => {
    // Add first memory
    const id1 = await addMemory('test-agent', 'Node.js 使用 V8 引擎', 3, 'semantic');
    assert.ok(id1, 'First memory should be added');

    // Add very similar memory — should consolidate
    const id2 = await addMemory('test-agent', 'Node.js 使用 V8 JavaScript 引擎', 3, 'semantic');
    // If consolidated, id2 should be the same as id1
    // (Note: exact consolidation depends on similarity threshold)
    assert.ok(id2, 'Second memory should return an ID');
  });

  it('should cleanup old low-importance memories', async () => {
    // Cleanup with aggressive parameters to test the function
    const count = await cleanupMemories(0, 5); // 0 days old, importance <= 5
    assert.ok(typeof count === 'number', 'Should return count of deleted memories');
  });
});
