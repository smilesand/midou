import { ChromaClient } from 'chromadb';
import { pipeline } from '@xenova/transformers';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR, MIDOU_PKG } from '../../midou.config.js';

export class TransformerMemorySystem {
  constructor() {
    this.embedder = null;
    this.dimension = 384; // all-MiniLM-L6-v2 dimension
    this.chromaClient = null;
    this.collectionName = 'midou_memories';
    this.collection = null;
    this.chromaProcess = null;
    this.chromaPort = parseInt(process.env.CHROMA_PORT, 10) || 8000;
    this.chromaDataPath = path.join(MIDOU_WORKSPACE_DIR, 'chroma_data');
  }

  /**
   * 确保 ChromaDB 服务器正在运行（本地模式）
   * 如果已在运行则直接复用，否则自动启动
   */
  async _ensureChromaServer() {
    const baseURL = `http://localhost:${this.chromaPort}`;

    // 检查服务器是否已经在运行
    try {
      const resp = await fetch(`${baseURL}/api/v2/heartbeat`);
      if (resp.ok) {
        console.log(`[ChromaDB] Server already running on port ${this.chromaPort}`);
        this.chromaClient = new ChromaClient({ host: 'localhost', port: this.chromaPort, ssl: false });
        return;
      }
    } catch (e) {
      // Server not running, we'll start it
    }

    // 确保数据目录存在
    await fs.mkdir(this.chromaDataPath, { recursive: true });

    // 启动 ChromaDB 服务器
    console.log(`[ChromaDB] Starting local server on port ${this.chromaPort}, data: ${this.chromaDataPath}`);
    const chromaBin = path.join(MIDOU_PKG, 'node_modules', '.bin', 'chroma');

    this.chromaProcess = spawn(chromaBin, [
      'run', '--path', this.chromaDataPath, '--port', String(this.chromaPort)
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: MIDOU_PKG,
    });

    this.chromaProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[ChromaDB stderr] ${msg}`);
    });

    this.chromaProcess.on('error', (err) => {
      console.error('[ChromaDB] Failed to start server process:', err.message);
    });

    this.chromaProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`[ChromaDB] Server exited with code ${code}`);
      }
      this.chromaProcess = null;
    });

    // 等待服务器就绪（最多 30 秒）
    const maxWait = 30000;
    const interval = 500;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
      try {
        const resp = await fetch(`${baseURL}/api/v2/heartbeat`);
        if (resp.ok) {
          console.log(`[ChromaDB] Server ready (waited ${waited}ms)`);
          this.chromaClient = new ChromaClient({ host: 'localhost', port: this.chromaPort, ssl: false });
          return;
        }
      } catch (e) {
        // Still starting...
      }
    }

    throw new Error(`ChromaDB server failed to start within ${maxWait / 1000}s`);
  }

  async init() {
    if (!this.embedder) {
      console.log('[Transformer Memory] Loading feature-extraction pipeline...');
      this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log('[Transformer Memory] Pipeline loaded.');
    }
    if (!this.collection) {
      try {
        // 确保 ChromaDB 服务器运行（本地模式）
        await this._ensureChromaServer();

        // 获取或创建 collection（不设置 embeddingFunction，我们手动传递 embeddings）
        this.collection = await this.chromaClient.getOrCreateCollection({
          name: this.collectionName,
          metadata: { "hnsw:space": "cosine" }
        });
        console.log(`[Transformer Memory] Connected to ChromaDB collection: ${this.collectionName}`);
      } catch (error) {
        console.error('[Transformer Memory] Failed to connect to ChromaDB:', error);
        throw error;
      }
    }
  }

  /**
   * 关闭 ChromaDB 服务器（如果由本系统启动）
   */
  async shutdown() {
    if (this.chromaProcess) {
      console.log('[ChromaDB] Shutting down server...');
      this.chromaProcess.kill('SIGTERM');
      // 等待最多 5 秒让进程退出
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          if (this.chromaProcess) {
            this.chromaProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);
        if (this.chromaProcess) {
          this.chromaProcess.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.chromaProcess = null;
      console.log('[ChromaDB] Server stopped.');
    }
    this.collection = null;
    this.chromaClient = null;
  }

  async getEmbedding(text) {
    const output = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  // 1. 记忆类型分离 (Episodic vs Semantic)
  async addMemory(agentId, content, type = 'semantic', importance = 3) {
    await this.init();
    const embedding = await this.getEmbedding(content);
    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    
    const metadata = {
      agentId: agentId || 'system',
      type, // 'episodic' (events/logs) or 'semantic' (facts/rules)
      timestamp: now,
      importance,
      accessCount: 0,
      lastAccessed: now,
      connections: JSON.stringify([]) // ChromaDB metadata values must be strings, numbers, or booleans
    };

    // 6. 动态更新与记忆巩固 (Memory Consolidation)
    if (type === 'semantic') {
      // 查找是否有高度相似的语义记忆
      const results = await this.collection.query({
        queryEmbeddings: [embedding],
        nResults: 1,
        where: {
          $and: [
            { type: 'semantic' },
            { agentId: agentId || 'system' }
          ]
        }
      });

      if (results.ids[0] && results.ids[0].length > 0) {
        const existingId = results.ids[0][0];
        const existingDistance = results.distances[0][0];
        // ChromaDB uses distance (1 - cosine_similarity) for cosine space
        const sim = 1 - existingDistance;
        
        if (sim > 0.92) {
          const existingMetadata = results.metadatas[0][0];
          const existingContent = results.documents[0][0];
          
          // 巩固记忆：更新时间戳和访问次数，合并内容（如果不同）
          existingMetadata.lastAccessed = now;
          existingMetadata.accessCount = (existingMetadata.accessCount || 0) + 1;
          existingMetadata.importance = Math.min(5, (existingMetadata.importance || 3) + 1);
          
          let newContent = existingContent;
          let newEmbedding = embedding;
          
          if (!existingContent.includes(content)) {
            newContent += `\n[补充]: ${content}`;
            // 重新计算 embedding
            newEmbedding = await this.getEmbedding(newContent);
          }
          
          await this.collection.update({
            ids: [existingId],
            embeddings: [newEmbedding],
            metadatas: [existingMetadata],
            documents: [newContent]
          });
          
          console.log(`[Transformer Memory] Consolidated into existing memory ${existingId}`);
          return existingId;
        }
      }
    }

    // 建立跨记忆关联 (Cross-memory connections)
    const connections = await this._buildConnections(embedding, id);
    metadata.connections = JSON.stringify(connections);

    await this.collection.add({
      ids: [id],
      embeddings: [embedding],
      metadatas: [metadata],
      documents: [content]
    });

    return id;
  }

  async _buildConnections(newEmbedding, newId) {
    const connections = [];
    try {
      const results = await this.collection.query({
        queryEmbeddings: [newEmbedding],
        nResults: 3
      });

      if (results.ids[0] && results.ids[0].length > 0) {
        for (let i = 0; i < results.ids[0].length; i++) {
          const targetId = results.ids[0][i];
          if (targetId === newId) continue;
          
          const distance = results.distances[0][i];
          const sim = 1 - distance;
          
          if (sim > 0.75) {
            connections.push(targetId);
            
            // Update target memory's connections
            const targetMetadata = results.metadatas[0][i];
            let targetConnections = [];
            try {
              targetConnections = JSON.parse(targetMetadata.connections || '[]');
            } catch (e) {}
            
            if (!targetConnections.includes(newId)) {
              targetConnections.push(newId);
              targetMetadata.connections = JSON.stringify(targetConnections);
              
              await this.collection.update({
                ids: [targetId],
                metadatas: [targetMetadata]
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('[Transformer Memory] Error building connections:', error);
    }
    return connections;
  }

  // 2. 检索方式 (Multi-head attention 模拟) & 4. 时序建模 (Time decay)
  async retrieve(agentId, query, limit = 5) {
    await this.init();
    
    const queryEmbedding = await this.getEmbedding(query);
    const now = Date.now();

    // Get more candidates to apply our custom scoring
    const fetchLimit = Math.max(limit * 3, 20);
    
    const whereClause = agentId ? { agentId: agentId } : undefined;
    
    let results;
    try {
      results = await this.collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: fetchLimit,
        where: whereClause
      });
    } catch (error) {
      console.error('[Transformer Memory] Error querying ChromaDB:', error);
      return [];
    }

    if (!results.ids[0] || results.ids[0].length === 0) return [];

    const candidates = [];
    for (let i = 0; i < results.ids[0].length; i++) {
      candidates.push({
        id: results.ids[0][i],
        content: results.documents[0][i],
        metadata: results.metadatas[0][i],
        distance: results.distances[0][i]
      });
    }
    
    const rawScores = candidates.map(m => {
      // 基础相似度 (Q * K^T)
      const dotProduct = 1 - m.distance;
      // 缩放点积注意力 (Scaled Dot-Product)
      const scaledAttention = dotProduct / Math.sqrt(this.dimension);

      // 时序建模：时间衰减 (Time Decay)
      // 假设半衰期为 30 天
      const ageDays = (now - (m.metadata.timestamp || now)) / (1000 * 60 * 60 * 24);
      const timeDecay = Math.exp(-0.05 * ageDays); // 衰减因子

      // 结合重要性和访问频率
      const importanceWeight = 1 + ((m.metadata.importance || 3) * 0.1);
      const frequencyWeight = 1 + Math.log1p(m.metadata.accessCount || 0) * 0.05;

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
      let connections = [];
      try {
        connections = JSON.parse(res.memory.metadata.connections || '[]');
      } catch (e) {}
      
      for (const connId of connections) {
        if (!expandedResults.has(connId)) {
          try {
            const connResult = await this.collection.get({
              ids: [connId]
            });
            
            if (connResult.ids && connResult.ids.length > 0) {
              const connMem = {
                id: connResult.ids[0],
                content: connResult.documents[0],
                metadata: connResult.metadatas[0]
              };
              
              // 关联记忆的权重是源记忆权重的一半
              expandedResults.set(connId, {
                memory: connMem,
                attentionWeight: res.attentionWeight * 0.5,
                isRelational: true,
                timeDecay: 1 // 关联记忆不单独计算衰减，继承源记忆的上下文
              });
            }
          } catch (e) {
            console.error(`[Transformer Memory] Failed to fetch connected memory ${connId}`);
          }
        }
      }
    }

    // 重新排序并截取
    const finalResults = Array.from(expandedResults.values())
      .sort((a, b) => b.attentionWeight - a.attentionWeight)
      .slice(0, limit);

    // 更新访问记录
    for (const res of finalResults) {
      res.memory.metadata.accessCount = (res.memory.metadata.accessCount || 0) + 1;
      res.memory.metadata.lastAccessed = now;
      
      try {
        await this.collection.update({
          ids: [res.memory.id],
          metadatas: [res.memory.metadata]
        });
      } catch (e) {
        console.error(`[Transformer Memory] Failed to update access stats for ${res.memory.id}`);
      }
    }

    // 5. 可解释性 (Attention weight visualization)
    return finalResults.map(r => ({
      content: r.memory.content,
      type: r.memory.metadata.type,
      attentionWeight: r.attentionWeight,
      metrics: {
        timeDecay: r.timeDecay,
        isRelational: r.isRelational || false
      },
      metadata: r.memory.metadata
    }));
  }

  async cleanup(daysOld = 30, maxImportanceToForget = 2) {
    await this.init();
    const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    
    try {
      // We need to fetch all to filter since ChromaDB where clause doesn't support complex logic well
      const allResults = await this.collection.get();
      
      if (!allResults.ids || allResults.ids.length === 0) return 0;
      
      const idsToDelete = [];
      
      for (let i = 0; i < allResults.ids.length; i++) {
        const id = allResults.ids[i];
        const metadata = allResults.metadatas[i];
        
        const isOld = (metadata.lastAccessed || 0) < cutoffTime;
        const isUnimportant = (metadata.importance || 3) <= maxImportanceToForget;
        
        if (isOld && isUnimportant) {
          idsToDelete.push(id);
        }
      }
      
      if (idsToDelete.length > 0) {
        await this.collection.delete({
          ids: idsToDelete
        });
        
        // We should ideally clean up connections in remaining memories, 
        // but for simplicity we'll let them be dangling references that fail gracefully
        
        console.log(`[Transformer Memory] Forgot ${idsToDelete.length} old/unimportant memories.`);
      }
      
      return idsToDelete.length;
    } catch (error) {
      console.error('[Transformer Memory] Error during cleanup:', error);
      return 0;
    }
  }
}

export const memorySystem = new TransformerMemorySystem();
