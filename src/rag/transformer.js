import { pipeline } from '@xenova/transformers';
import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from '../../midou.config.js';

const MEMORY_FILE = path.join(MIDOU_WORKSPACE_DIR, 'transformer_memory.json');

export class TransformerMemorySystem {
  constructor() {
    this.embedder = null;
    this.memories = [];
    this.dimension = 384; // all-MiniLM-L6-v2 dimension
  }

  async init() {
    if (!this.embedder) {
      console.log('[Transformer Memory] Loading feature-extraction pipeline...');
      this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log('[Transformer Memory] Pipeline loaded.');
    }
    await this.load();
  }

  async load() {
    try {
      const data = await fs.readFile(MEMORY_FILE, 'utf-8');
      this.memories = JSON.parse(data);
      console.log(`[Transformer Memory] Loaded ${this.memories.length} memories.`);
    } catch (e) {
      this.memories = [];
    }
  }

  async save() {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    await fs.writeFile(MEMORY_FILE, JSON.stringify(this.memories, null, 2), 'utf-8');
  }

  async getEmbedding(text) {
    const output = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  // 1. 记忆类型分离 (Episodic vs Semantic)
  async addMemory(agentId, content, type = 'semantic', importance = 3) {
    await this.init();
    const embedding = await this.getEmbedding(content);
    
    const memory = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      agentId: agentId || 'system',
      type, // 'episodic' (events/logs) or 'semantic' (facts/rules)
      content,
      embedding,
      metadata: {
        timestamp: Date.now(),
        importance,
        accessCount: 0,
        lastAccessed: Date.now(),
        connections: [] // 关联推理的边
      }
    };

    // 6. 动态更新与记忆巩固 (Memory Consolidation)
    if (type === 'semantic') {
      // 查找是否有高度相似的语义记忆
      let consolidated = false;
      for (const existing of this.memories) {
        if (existing.type === 'semantic' && existing.agentId === memory.agentId) {
          const sim = this.cosineSimilarity(embedding, existing.embedding);
          if (sim > 0.92) {
            // 巩固记忆：更新时间戳和访问次数，合并内容（如果不同）
            existing.metadata.lastAccessed = Date.now();
            existing.metadata.accessCount++;
            existing.metadata.importance = Math.min(5, existing.metadata.importance + 1);
            if (!existing.content.includes(content)) {
              existing.content += `\n[补充]: ${content}`;
              // 重新计算 embedding
              existing.embedding = await this.getEmbedding(existing.content);
            }
            consolidated = true;
            console.log(`[Transformer Memory] Consolidated into existing memory ${existing.id}`);
            break;
          }
        }
      }
      if (!consolidated) {
        this.memories.push(memory);
      }
    } else {
      this.memories.push(memory);
    }

    // 建立跨记忆关联 (Cross-memory connections)
    await this._buildConnections(memory);

    await this.save();
    return memory.id;
  }

  async _buildConnections(newMemory) {
    // 查找最相似的几个记忆建立关联
    const similarities = this.memories
      .filter(m => m.id !== newMemory.id)
      .map(m => ({
        id: m.id,
        sim: this.cosineSimilarity(newMemory.embedding, m.embedding)
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3);

    for (const target of similarities) {
      if (target.sim > 0.75) {
        newMemory.metadata.connections.push(target.id);
        const targetMem = this.memories.find(m => m.id === target.id);
        if (targetMem && !targetMem.metadata.connections.includes(newMemory.id)) {
          targetMem.metadata.connections.push(newMemory.id);
        }
      }
    }
  }

  // 2. 检索方式 (Multi-head attention 模拟) & 4. 时序建模 (Time decay)
  async retrieve(agentId, query, limit = 5) {
    await this.init();
    if (this.memories.length === 0) return [];

    const queryEmbedding = await this.getEmbedding(query);
    const now = Date.now();

    // 计算 Attention Scores (Q * K^T / sqrt(d))
    let candidates = this.memories.filter(m => !agentId || m.agentId === agentId);
    if (candidates.length === 0) return [];
    
    const rawScores = candidates.map(m => {
      // 基础相似度 (Q * K^T)
      const dotProduct = this.cosineSimilarity(queryEmbedding, m.embedding);
      // 缩放点积注意力 (Scaled Dot-Product)
      const scaledAttention = dotProduct / Math.sqrt(this.dimension);

      // 时序建模：时间衰减 (Time Decay)
      // 假设半衰期为 30 天
      const ageDays = (now - m.metadata.timestamp) / (1000 * 60 * 60 * 24);
      const timeDecay = Math.exp(-0.05 * ageDays); // 衰减因子

      // 结合重要性和访问频率
      const importanceWeight = 1 + (m.metadata.importance * 0.1);
      const frequencyWeight = 1 + Math.log1p(m.metadata.accessCount) * 0.05;

      const finalScore = scaledAttention * timeDecay * importanceWeight * frequencyWeight;

      return { memory: m, score: finalScore, scaledAttention, timeDecay };
    });

    // Softmax 归一化得到 Attention Weights
    const maxScore = Math.max(...rawScores.map(r => r.score));
    const expScores = rawScores.map(r => ({
      ...r,
      exp: Math.exp(r.score - maxScore) // 减去 maxScore 防止溢出
    }));
    const sumExp = expScores.reduce((sum, r) => sum + r.exp, 0);
    
    const attentionResults = expScores.map(r => ({
      ...r,
      attentionWeight: r.exp / sumExp
    })).sort((a, b) => b.attentionWeight - a.attentionWeight);

    // 7. 关联推理 (Cross-memory attention mechanism)
    // 如果检索到了某个记忆，将其强关联的记忆也提升权重
    const topResults = attentionResults.slice(0, limit);
    const expandedResults = new Map(); // id -> result

    for (const res of topResults) {
      expandedResults.set(res.memory.id, res);
      
      // 引入关联记忆 (1跳推理)
      for (const connId of res.memory.metadata.connections) {
        if (!expandedResults.has(connId)) {
          const connMem = this.memories.find(m => m.id === connId);
          if (connMem) {
            // 关联记忆的权重是源记忆权重的一半
            expandedResults.set(connId, {
              memory: connMem,
              attentionWeight: res.attentionWeight * 0.5,
              isRelational: true,
              timeDecay: 1 // 关联记忆不单独计算衰减，继承源记忆的上下文
            });
          }
        }
      }
    }

    // 重新排序并截取
    const finalResults = Array.from(expandedResults.values())
      .sort((a, b) => b.attentionWeight - a.attentionWeight)
      .slice(0, limit);

    // 更新访问记录
    let needsSave = false;
    for (const res of finalResults) {
      res.memory.metadata.accessCount++;
      res.memory.metadata.lastAccessed = now;
      needsSave = true;
    }
    if (needsSave) await this.save();

    // 5. 可解释性 (Attention weight visualization)
    return finalResults.map(r => ({
      content: r.memory.content,
      type: r.memory.type,
      attentionWeight: r.attentionWeight,
      metrics: {
        timeDecay: r.timeDecay,
        isRelational: r.isRelational || false
      },
      metadata: r.memory.metadata
    }));
  }

  cosineSimilarity(vecA, vecB) {
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

  async cleanup(daysOld = 30, maxImportanceToForget = 2) {
    const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    const initialLength = this.memories.length;
    
    this.memories = this.memories.filter(m => {
      const isOld = m.metadata.lastAccessed < cutoffTime;
      const isUnimportant = m.metadata.importance <= maxImportanceToForget;
      return !(isOld && isUnimportant);
    });
    
    const deletedCount = initialLength - this.memories.length;
    if (deletedCount > 0) {
      // 清理失效的连接
      const validIds = new Set(this.memories.map(m => m.id));
      for (const m of this.memories) {
        m.metadata.connections = m.metadata.connections.filter(id => validIds.has(id));
      }
      await this.save();
      console.log(`[Transformer Memory] Forgot ${deletedCount} old/unimportant memories.`);
    }
    return deletedCount;
  }
}

export const memorySystem = new TransformerMemorySystem();
