/**
 * AST 记忆插件 — 基于 agent-memory-ast-guide.pdf 设计
 *
 * 实现多层记忆架构：
 * - Working Memory：LRU + 重要度淘汰的短期记忆
 * - Semantic Memory：基于余弦相似度的向量搜索
 * - Episodic Memory：基于图关系的情景记忆
 * - 记忆去重：相似度 > 0.92 触发合并
 * - 冲突检测：相似度 > 0.80 触发矛盾分析
 * - 信心回传：基于反馈调整记忆置信度
 * - 睡眠整合：定期聚类 + 总结
 *
 * 使用纯 JSON 文件存储（无外部数据库依赖）。
 * 向量嵌入通过 NodeLLM 的 embed() 或简单的 TF-IDF 方案实现。
 */

import fs from 'fs/promises';
import path from 'path';

// ── LLM 访问函数（通过 PluginContext 依赖注入，不再硬引用源码路径） ──
let _createLLM: (options?: Record<string, unknown>) => unknown = () => {
  throw new Error('[AST-Memory] LLM 未初始化，请确保插件已通过 install() 安装');
};
let _quickAsk: (prompt: string, systemPrompt?: string) => Promise<string> = async () => {
  throw new Error('[AST-Memory] quickAsk 未初始化，请确保插件已通过 install() 安装');
};

// ══════════════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════════════

/** 记忆条目 */
interface MemoryEntry {
  id: string;
  content: string;
  type: 'semantic' | 'episodic' | 'procedural';
  importance: number;       // 1-5
  confidence: number;       // 0-1
  embedding: number[];      // 向量嵌入
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  status: 'active' | 'consolidated' | 'deprecated';
  connections: string[];    // 关联记忆 ID
  tags: string[];
  source?: string;          // 来源
}

/** 图关系边 */
interface MemoryEdge {
  id: string;
  source: string;
  target: string;
  type: 'SIMILAR_TO' | 'CONFLICTS_WITH' | 'DERIVES_FROM' | 'CONSOLIDATES' | 'MENTIONS_CODE';
  weight: number;
  createdAt: number;
}

/** Working Memory 缓存项 */
interface WorkingMemoryItem {
  entry: MemoryEntry;
  activationLevel: number;
  insertedAt: number;
}

/** 存储结构 */
interface ASTMemoryStore {
  memories: Record<string, MemoryEntry>;
  edges: MemoryEdge[];
  consolidations: Array<{
    timestamp: number;
    summary: string;
    sourceIds: string[];
  }>;
  stats: {
    totalAdded: number;
    totalMerged: number;
    totalConflicts: number;
    lastConsolidation: number;
  };
}

/** 搜索结果 */
interface SearchResult {
  content: string;
  type: string;
  attentionWeight: number;
  metrics: {
    timeDecay: number;
    isRelational: boolean;
    similarity?: number;
    graphDepth?: number;
  };
  metadata: Record<string, unknown>;
}

// ══════════════════════════════════════════════════
// 核心引擎
// ══════════════════════════════════════════════════

class ASTMemoryEngine {
  private storeDir: string;
  private stores: Map<string, ASTMemoryStore> = new Map();
  private workingMemory: Map<string, WorkingMemoryItem[]> = new Map();
  private embeddingCache: Map<string, number[]> = new Map();
  private useNodeLLMEmbed: boolean = false;

  readonly WORKING_MEMORY_CAPACITY = 20;
  readonly DEDUP_THRESHOLD = 0.92;
  readonly CONFLICT_THRESHOLD = 0.80;
  readonly EMBEDDING_DIM = 64;  // 简化 TF-IDF 维度

  constructor(baseDir: string) {
    this.storeDir = baseDir;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });

    // 检测是否可用 NodeLLM embed
    try {
      const llm = _createLLM() as Record<string, unknown>;
      if (typeof llm.embed === 'function') {
        this.useNodeLLMEmbed = true;
        console.log('[AST-Memory] 使用 NodeLLM embed 作为向量引擎');
      }
    } catch {
      console.log('[AST-Memory] NodeLLM embed 不可用，使用 TF-IDF 后备方案');
    }
  }

  async shutdown(): Promise<void> {
    // 持久化所有 stores
    for (const [agentId, store] of this.stores) {
      await this._saveStore(agentId, store);
    }
    this.stores.clear();
    this.workingMemory.clear();
    this.embeddingCache.clear();
  }

  /**
   * 写入管线: 去重 → 冲突检测 → 向量化 → 持久化
   */
  async addMemory(
    agentId: string,
    content: string,
    type: string,
    importance: number
  ): Promise<string> {
    const store = await this._getStore(agentId);

    // 1. 向量化
    const embedding = await this._embed(content);

    // 2. 去重检查
    const duplicates = this._findSimilar(store, embedding, this.DEDUP_THRESHOLD);
    if (duplicates.length > 0) {
      const existing = duplicates[0];
      // 合并
      const merged = this._mergeMemories(existing.entry, content, importance);
      store.memories[existing.entry.id] = merged;
      store.stats.totalMerged++;
      await this._saveStore(agentId, store);
      return existing.entry.id;
    }

    // 3. 冲突检测
    const conflicts = this._findSimilar(store, embedding, this.CONFLICT_THRESHOLD)
      .filter(s => s.similarity < this.DEDUP_THRESHOLD);
    
    // 4. 创建新记忆
    const id = `ast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const entry: MemoryEntry = {
      id,
      content,
      type: (type as MemoryEntry['type']) || 'semantic',
      importance: Math.min(5, Math.max(1, importance)),
      confidence: 1.0,
      embedding,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
      status: 'active',
      connections: [],
      tags: this._extractTags(content),
    };

    store.memories[id] = entry;
    store.stats.totalAdded++;

    // 5. 建立冲突边
    for (const conflict of conflicts) {
      const edge: MemoryEdge = {
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`,
        source: id,
        target: conflict.entry.id,
        type: 'SIMILAR_TO',
        weight: conflict.similarity,
        createdAt: Date.now(),
      };
      store.edges.push(edge);
      entry.connections.push(conflict.entry.id);
      conflict.entry.connections.push(id);
    }

    if (conflicts.length > 0) {
      store.stats.totalConflicts += conflicts.length;
    }

    // 6. 更新 Working Memory
    this._addToWorkingMemory(agentId, entry);

    // 7. 持久化
    await this._saveStore(agentId, store);

    // 8. 检查是否需要整合
    if (this._shouldConsolidate(store)) {
      this._scheduleConsolidation(agentId);
    }

    return id;
  }

  /**
   * 读取管线: 向量搜索 → 图扩展 → Working Memory 提升 → 排序
   */
  async searchMemory(
    agentId: string,
    query: string,
    limit: number
  ): Promise<SearchResult[]> {
    const store = await this._getStore(agentId);
    const queryEmbedding = await this._embed(query);

    // 1. 向量搜索
    const vectorResults = this._vectorSearch(store, queryEmbedding, limit * 3);

    // 2. 图扩展（K-hop neighborhood）
    const expandedIds = new Set<string>();
    for (const r of vectorResults.slice(0, 5)) {
      const neighbors = this._getNeighbors(store, r.entry.id, 2);
      for (const nId of neighbors) {
        expandedIds.add(nId);
      }
    }

    // 加入图扩展的结果
    for (const nId of expandedIds) {
      if (!vectorResults.some(r => r.entry.id === nId) && store.memories[nId]) {
        const entry = store.memories[nId];
        const sim = this._cosineSimilarity(queryEmbedding, entry.embedding);
        vectorResults.push({ entry, similarity: sim });
      }
    }

    // 3. Working Memory 活跃度提升
    const wm = this.workingMemory.get(agentId) || [];
    const wmIds = new Set(wm.map(w => w.entry.id));

    // 4. 综合评分
    const scored = vectorResults.map(r => {
      const entry = r.entry;
      // 更新访问统计
      entry.lastAccessed = Date.now();
      entry.accessCount++;

      // 时间衰减
      const ageHours = (Date.now() - entry.createdAt) / 3600000;
      const timeDecay = Math.exp(-ageHours / (24 * 30));

      // 重要度计算: 0.4×访问频率 + 0.3×连接度 + 0.3×信息密度
      const freqScore = Math.min(entry.accessCount / 10, 1);
      const connScore = Math.min(entry.connections.length / 5, 1);
      const infoScore = Math.min(entry.content.length / 500, 1);
      const dynamicImportance = 0.4 * freqScore + 0.3 * connScore + 0.3 * infoScore;

      // Working Memory 加成
      const wmBoost = wmIds.has(entry.id) ? 0.2 : 0;

      // 最终注意力权重
      const attentionWeight =
        r.similarity * 0.4 +
        entry.confidence * 0.15 +
        (entry.importance / 5) * 0.15 +
        dynamicImportance * 0.15 +
        timeDecay * 0.1 +
        wmBoost * 0.05;

      const isRelational = entry.connections.length > 0 ||
        expandedIds.has(entry.id);

      return {
        content: entry.content,
        type: entry.type,
        attentionWeight: Math.min(attentionWeight, 1),
        metrics: {
          timeDecay,
          isRelational,
          similarity: r.similarity,
          graphDepth: expandedIds.has(entry.id) ? 1 : 0,
        },
        metadata: {
          id: entry.id,
          importance: entry.importance,
          confidence: entry.confidence,
          accessCount: entry.accessCount,
          tags: entry.tags,
          connections: entry.connections,
        },
      };
    });

    // 5. 排序并截取
    scored.sort((a, b) => b.attentionWeight - a.attentionWeight);

    // 6. 更新 Working Memory
    for (const r of scored.slice(0, 3)) {
      const entry = store.memories[r.metadata.id as string];
      if (entry) this._addToWorkingMemory(agentId, entry);
    }

    return scored.slice(0, limit);
  }

  /**
   * 信心回传 — 基于反馈更新记忆置信度
   */
  async updateConfidence(
    agentId: string,
    memoryId: string,
    feedback: 'success' | 'failure'
  ): Promise<void> {
    const store = await this._getStore(agentId);
    const entry = store.memories[memoryId];
    if (!entry) return;

    if (feedback === 'success') {
      entry.confidence = Math.min(1.0, entry.confidence + 0.1 * (1 - entry.confidence));
    } else {
      entry.confidence = Math.max(0.0, entry.confidence - 0.2 * entry.confidence);
    }

    await this._saveStore(agentId, store);
  }

  /**
   * 睡眠整合 — 聚类、总结、衰减
   */
  async consolidate(agentId: string): Promise<string> {
    const store = await this._getStore(agentId);
    const activeMemories = Object.values(store.memories)
      .filter(m => m.status === 'active');

    if (activeMemories.length < 5) return '记忆数量不足，跳过整合';

    // 1. 简单聚类（基于标签重叠）
    const clusters = this._clusterByTags(activeMemories);
    const summaries: string[] = [];

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;

      // 2. 用 LLM 总结聚类
      const clusterContent = cluster.map(m => `- ${m.content}`).join('\n');
      try {
        const summary = await _quickAsk(
          `请将以下相关记忆条目整合为一条简洁的总结：\n\n${clusterContent}`,
          '你是记忆整合模块。将多条相关记忆合并为一条精简的总结。'
        );

        // 3. 创建整合记忆
        const consolidatedId = `con-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`;
        const maxImportance = Math.max(...cluster.map(m => m.importance));
        const embedding = await this._embed(summary);

        store.memories[consolidatedId] = {
          id: consolidatedId,
          content: summary,
          type: 'semantic',
          importance: Math.min(5, maxImportance + 1),
          confidence: 0.9,
          embedding,
          createdAt: Date.now(),
          lastAccessed: Date.now(),
          accessCount: 0,
          status: 'active',
          connections: cluster.map(m => m.id),
          tags: [...new Set(cluster.flatMap(m => m.tags))],
        };

        // 4. 标记原始记忆为已整合
        for (const m of cluster) {
          m.status = 'consolidated';
          // 添加 CONSOLIDATES 边
          store.edges.push({
            id: `edge-con-${Date.now()}`,
            source: consolidatedId,
            target: m.id,
            type: 'CONSOLIDATES',
            weight: 1.0,
            createdAt: Date.now(),
          });
        }

        store.consolidations.push({
          timestamp: Date.now(),
          summary,
          sourceIds: cluster.map(m => m.id),
        });

        summaries.push(`整合 ${cluster.length} 条记忆 → "${summary.slice(0, 60)}..."`);
      } catch (err) {
        console.error('[AST-Memory] 整合失败:', err);
      }
    }

    // 5. 记忆衰减
    const now = Date.now();
    for (const m of activeMemories) {
      const ageDay = (now - m.lastAccessed) / (3600000 * 24);
      if (ageDay > 60 && m.importance <= 2 && m.accessCount < 3) {
        m.status = 'deprecated';
      }
    }

    store.stats.lastConsolidation = now;
    await this._saveStore(agentId, store);

    return summaries.length > 0
      ? `整合完成：\n${summaries.join('\n')}`
      : '没有需要整合的记忆聚类';
  }

  /**
   * 清理已废弃的记忆
   */
  async cleanup(daysOld: number, maxImportance: number): Promise<number> {
    let total = 0;
    for (const [agentId, store] of this.stores) {
      const threshold = Date.now() - daysOld * 86400000;
      for (const [id, m] of Object.entries(store.memories)) {
        if (
          m.createdAt < threshold &&
          m.importance <= maxImportance &&
          m.accessCount < 3
        ) {
          m.status = 'deprecated';
          total++;
        }
      }
      await this._saveStore(agentId, store);
    }
    return total;
  }

  // ══════════════════════════════════════════════════
  // 内部方法
  // ══════════════════════════════════════════════════

  /**
   * 向量嵌入 — 优先使用 NodeLLM embed，后备使用 TF-IDF
   */
  private async _embed(text: string): Promise<number[]> {
    const cacheKey = text.slice(0, 200);
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey)!;
    }

    let embedding: number[];

    if (this.useNodeLLMEmbed) {
      try {
        const llm = _createLLM() as Record<string, (...args: unknown[]) => unknown>;
        const result = await llm.embed(text);
        embedding = Array.isArray(result) ? result : (result as { embedding: number[] }).embedding || [];
        if (embedding.length === 0) throw new Error('empty');
      } catch {
        embedding = this._tfidfEmbed(text);
      }
    } else {
      embedding = this._tfidfEmbed(text);
    }

    this.embeddingCache.set(cacheKey, embedding);
    // LRU 缓存限制
    if (this.embeddingCache.size > 500) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }

    return embedding;
  }

  /**
   * 简单 TF-IDF 嵌入（无外部依赖后备方案）
   */
  private _tfidfEmbed(text: string): number[] {
    const vec = new Float64Array(this.EMBEDDING_DIM);
    const words = text.toLowerCase().split(/\s+|[,，。！？；：、]/);

    for (const word of words) {
      if (word.length < 2) continue;
      // 用字符码作为哈希分桶
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      const bucket = Math.abs(hash) % this.EMBEDDING_DIM;
      vec[bucket] += 1;
    }

    // L2 归一化
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] ** 2;
    norm = Math.sqrt(norm) || 1;
    const result: number[] = [];
    for (let i = 0; i < vec.length; i++) {
      result.push(vec[i] / norm);
    }
    return result;
  }

  /**
   * 余弦相似度
   */
  private _cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] ** 2;
      normB += b[i] ** 2;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * 查找相似记忆
   */
  private _findSimilar(
    store: ASTMemoryStore,
    embedding: number[],
    threshold: number
  ): Array<{ entry: MemoryEntry; similarity: number }> {
    const results: Array<{ entry: MemoryEntry; similarity: number }> = [];

    for (const entry of Object.values(store.memories)) {
      if (entry.status === 'deprecated') continue;
      const sim = this._cosineSimilarity(embedding, entry.embedding);
      if (sim >= threshold) {
        results.push({ entry, similarity: sim });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results;
  }

  /**
   * 向量搜索
   */
  private _vectorSearch(
    store: ASTMemoryStore,
    queryEmbedding: number[],
    limit: number
  ): Array<{ entry: MemoryEntry; similarity: number }> {
    const results: Array<{ entry: MemoryEntry; similarity: number }> = [];

    for (const entry of Object.values(store.memories)) {
      if (entry.status === 'deprecated') continue;
      const sim = this._cosineSimilarity(queryEmbedding, entry.embedding);
      results.push({ entry, similarity: sim });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * K-hop 邻域扩展
   */
  private _getNeighbors(store: ASTMemoryStore, memoryId: string, maxHops: number): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: memoryId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxHops) continue;
      visited.add(id);

      // 从边表中查找邻居
      for (const edge of store.edges) {
        if (edge.source === id && !visited.has(edge.target)) {
          queue.push({ id: edge.target, depth: depth + 1 });
        }
        if (edge.target === id && !visited.has(edge.source)) {
          queue.push({ id: edge.source, depth: depth + 1 });
        }
      }
    }

    visited.delete(memoryId);
    return visited;
  }

  /**
   * 合并重复记忆
   */
  private _mergeMemories(existing: MemoryEntry, newContent: string, newImportance: number): MemoryEntry {
    return {
      ...existing,
      content: existing.content.length >= newContent.length
        ? existing.content
        : newContent,
      importance: Math.max(existing.importance, newImportance),
      confidence: Math.min(1.0, existing.confidence + 0.05),
      lastAccessed: Date.now(),
      accessCount: existing.accessCount + 1,
    };
  }

  /**
   * Working Memory 管理（LRU + 重要度淘汰）
   */
  private _addToWorkingMemory(agentId: string, entry: MemoryEntry): void {
    let wm = this.workingMemory.get(agentId);
    if (!wm) {
      wm = [];
      this.workingMemory.set(agentId, wm);
    }

    // 已存在则提升激活度
    const existing = wm.find(w => w.entry.id === entry.id);
    if (existing) {
      existing.activationLevel = Math.min(1.0, existing.activationLevel + 0.2);
      return;
    }

    // 容量淘汰
    if (wm.length >= this.WORKING_MEMORY_CAPACITY) {
      // 按 激活度 × 重要度 排序，淘汰最低的
      wm.sort((a, b) =>
        (a.activationLevel * a.entry.importance) -
        (b.activationLevel * b.entry.importance)
      );
      wm.shift();
    }

    wm.push({
      entry,
      activationLevel: 0.5 + (entry.importance / 10),
      insertedAt: Date.now(),
    });

    // 自然衰减所有项的激活度
    for (const item of wm) {
      item.activationLevel *= 0.95;
    }
  }

  /**
   * 提取标签
   */
  private _extractTags(content: string): string[] {
    const tags: string[] = [];
    // 提取中文关键词（2-4字）
    const cnMatches = content.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (cnMatches) {
      const freq = new Map<string, number>();
      cnMatches.forEach(w => freq.set(w, (freq.get(w) || 0) + 1));
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      tags.push(...sorted.slice(0, 5).map(([w]) => w));
    }

    // 提取英文关键词
    const enMatches = content.match(/\b[a-zA-Z_]\w{2,}\b/g);
    if (enMatches) {
      const freq = new Map<string, number>();
      enMatches.forEach(w => {
        const lower = w.toLowerCase();
        freq.set(lower, (freq.get(lower) || 0) + 1);
      });
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      tags.push(...sorted.slice(0, 5).map(([w]) => w));
    }

    return [...new Set(tags)];
  }

  /**
   * 按标签聚类
   */
  private _clusterByTags(memories: MemoryEntry[]): MemoryEntry[][] {
    const clusters: MemoryEntry[][] = [];
    const assigned = new Set<string>();

    for (const mem of memories) {
      if (assigned.has(mem.id)) continue;
      const cluster = [mem];
      assigned.add(mem.id);

      for (const other of memories) {
        if (assigned.has(other.id)) continue;
        const overlap = mem.tags.filter(t => other.tags.includes(t)).length;
        if (overlap >= 2) {
          cluster.push(other);
          assigned.add(other.id);
        }
      }

      if (cluster.length >= 2) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * 是否需要自动整合
   */
  private _shouldConsolidate(store: ASTMemoryStore): boolean {
    const activeCount = Object.values(store.memories)
      .filter(m => m.status === 'active').length;
    const hoursSinceLastConsolidation =
      (Date.now() - store.stats.lastConsolidation) / 3600000;

    return activeCount > 50 && hoursSinceLastConsolidation > 24;
  }

  /**
   * 异步调度整合
   */
  private _scheduleConsolidation(agentId: string): void {
    setTimeout(() => {
      this.consolidate(agentId).catch(err => {
        console.error('[AST-Memory] 自动整合失败:', err);
      });
    }, 5000);
  }

  // ── 持久化 ──

  private async _getStore(agentId: string): Promise<ASTMemoryStore> {
    if (this.stores.has(agentId)) return this.stores.get(agentId)!;

    const filePath = path.join(this.storeDir, `${agentId}.json`);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const store = JSON.parse(data) as ASTMemoryStore;
      this.stores.set(agentId, store);
      return store;
    } catch {
      const store: ASTMemoryStore = {
        memories: {},
        edges: [],
        consolidations: [],
        stats: {
          totalAdded: 0,
          totalMerged: 0,
          totalConflicts: 0,
          lastConsolidation: 0,
        },
      };
      this.stores.set(agentId, store);
      return store;
    }
  }

  private async _saveStore(agentId: string, store: ASTMemoryStore): Promise<void> {
    const filePath = path.join(this.storeDir, `${agentId}.json`);
    await fs.mkdir(this.storeDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  }
}

// ══════════════════════════════════════════════════
// 插件导出 — 实现 MemoryProvider 接口
// ══════════════════════════════════════════════════

class ASTMemoryProvider {
  readonly name = 'ast-memory';
  private engine: ASTMemoryEngine;

  constructor(baseDir: string) {
    this.engine = new ASTMemoryEngine(path.join(baseDir, 'ast-store'));
  }

  async init(): Promise<void> {
    await this.engine.init();
  }

  async shutdown(): Promise<void> {
    await this.engine.shutdown();
  }

  async addMemory(agentId: string, content: string, type: string, importance: number): Promise<string> {
    return this.engine.addMemory(agentId, content, type, importance);
  }

  async searchMemory(agentId: string, query: string, limit: number): Promise<SearchResult[]> {
    return this.engine.searchMemory(agentId, query, limit);
  }

  async cleanup(daysOld: number, maxImportance: number): Promise<number> {
    return this.engine.cleanup(daysOld, maxImportance);
  }

  /**
   * 暴露引擎的高级功能（通过插件上下文的自定义方法）
   */
  getEngine() {
    return this.engine;
  }
}

/** 插件上下文类型（对齐 src/types.ts 中的 PluginContext） */
interface PluginContextLike {
  systemManager: unknown;
  app: unknown;
  registerTool: (definition: {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }, handler: (args: Record<string, unknown>, context: { systemManager: unknown; agentId: string }) => Promise<string> | string) => void;
  registerMemoryProvider: (provider: ASTMemoryProvider) => void;
  createLLM: (options?: Record<string, unknown>) => unknown;
  quickAsk: (prompt: string, systemPrompt?: string) => Promise<string>;
  workspaceDir: string;
}

/**
 * 插件安装入口
 */
export default {
  name: 'ast-memory',

  async install(context: PluginContextLike): Promise<void> {
    // 注入 LLM 依赖（核心设计：通过上下文获取而非硬引用路径）
    _createLLM = context.createLLM;
    _quickAsk = context.quickAsk;

    const baseDir = context.workspaceDir || process.cwd();

    const provider = new ASTMemoryProvider(baseDir);
    context.registerMemoryProvider(provider);

    // 注册额外的记忆管理工具
    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'consolidate_memory',
          description: '触发记忆整合 — 将相关记忆聚类并总结为精炼的知识。',
          parameters: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'Agent ID' },
            },
          },
        },
      },
      async (args) => {
        const agentId = (args.agent_id as string) || 'midou';
        return await provider.getEngine().consolidate(agentId);
      }
    );

    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'memory_feedback',
          description: '对某条记忆提供正面或负面反馈，调整其置信度。',
          parameters: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'Agent ID' },
              memory_id: { type: 'string', description: '记忆 ID' },
              feedback: {
                type: 'string',
                enum: ['success', 'failure'],
                description: '反馈类型',
              },
            },
            required: ['memory_id', 'feedback'],
          },
        },
      },
      async (args) => {
        const agentId = (args.agent_id as string) || 'midou';
        const memoryId = args.memory_id as string;
        const feedback = args.feedback as 'success' | 'failure';
        await provider.getEngine().updateConfidence(agentId, memoryId, feedback);
        return `记忆 ${memoryId} 的置信度已更新 (${feedback})`;
      }
    );

    console.log('[AST-Memory] 插件安装完成');
  },
};
