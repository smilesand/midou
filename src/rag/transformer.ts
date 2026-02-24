import { ChromaClient, type Collection } from 'chromadb';
import { pipeline, type Pipeline } from '@xenova/transformers';
import { spawn, execSync, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR, MIDOU_PKG } from '../config.js';
import type { MemoryMetadata, MemoryResult } from '../types.js';

interface MemoryCandidate {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  distance: number;
}

interface ScoredMemory {
  memory: MemoryCandidate;
  score: number;
  scaledAttention: number;
  timeDecay: number;
  exp?: number;
  attentionWeight?: number;
  isRelational?: boolean;
}

export class TransformerMemorySystem {
  embedder: Pipeline | null;
  dimension: number;
  chromaClient: ChromaClient | null;
  collectionName: string;
  collection: Collection | null;
  chromaProcess: ChildProcess | null;
  chromaPort: number;
  chromaDataPath: string;

  constructor() {
    this.embedder = null;
    this.dimension = 384; // all-MiniLM-L6-v2 dimension
    this.chromaClient = null;
    this.collectionName = 'midou_memories';
    this.collection = null;
    this.chromaProcess = null;
    this.chromaPort = parseInt(process.env.CHROMA_PORT || '', 10) || 8000;
    this.chromaDataPath = path.join(MIDOU_WORKSPACE_DIR, 'chroma_data');
  }

  async _checkHeartbeat(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const resp = await fetch(
        `http://localhost:${this.chromaPort}/api/v2/heartbeat`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      return resp.ok;
    } catch (_e) {
      clearTimeout(timeout);
      return false;
    }
  }

  async _killPortProcess(): Promise<void> {
    try {
      const pids = execSync(`lsof -ti :${this.chromaPort}`, {
        encoding: 'utf8',
      }).trim();
      if (pids) {
        console.log(
          `[ChromaDB] Killing orphaned process(es) on port ${this.chromaPort}: ${pids.replace(/\n/g, ', ')}`
        );
        execSync(`kill -9 ${pids.replace(/\n/g, ' ')}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (_e) {
      // lsof returns non-zero if no process found
    }
  }

  async _spawnChroma(): Promise<boolean> {
    const chromaBin = path.join(MIDOU_PKG, 'node_modules', '.bin', 'chroma');

    return new Promise((resolve) => {
      let earlyExit = false;

      this.chromaProcess = spawn(
        chromaBin,
        [
          'run',
          '--path',
          this.chromaDataPath,
          '--port',
          String(this.chromaPort),
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: MIDOU_PKG,
        }
      );

      this.chromaProcess.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('OpenTelemetry')) {
          console.error(`[ChromaDB stderr] ${msg}`);
        }
      });

      this.chromaProcess.on('error', (err: Error) => {
        console.error(
          '[ChromaDB] Failed to start server process:',
          err.message
        );
        earlyExit = true;
        resolve(false);
      });

      this.chromaProcess.on('exit', (code: number | null) => {
        if (code !== null && code !== 0) {
          console.error(`[ChromaDB] Server exited with code ${code}`);
        }
        earlyExit = true;
        this.chromaProcess = null;
      });

      setTimeout(() => {
        if (earlyExit) {
          resolve(false);
        } else {
          resolve(true);
        }
      }, 1500);
    });
  }

  async _ensureChromaServer(): Promise<void> {
    if (await this._checkHeartbeat()) {
      console.log(
        `[ChromaDB] Server already running on port ${this.chromaPort}`
      );
      this.chromaClient = new ChromaClient({
        host: 'localhost',
        port: this.chromaPort,
        ssl: false,
      } as Record<string, unknown>);
      return;
    }

    await fs.mkdir(this.chromaDataPath, { recursive: true });

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(
        `[ChromaDB] Starting local server on port ${this.chromaPort} (attempt ${attempt}/${maxAttempts})`
      );

      const spawned = await this._spawnChroma();

      if (!spawned) {
        console.warn(
          `[ChromaDB] Server failed to start — port ${this.chromaPort} may be occupied`
        );
        await this._killPortProcess();
        continue;
      }

      const maxWait = 15000;
      const interval = 500;
      let waited = 0;

      while (waited < maxWait) {
        await new Promise((r) => setTimeout(r, interval));
        waited += interval;

        if (!this.chromaProcess) {
          console.warn(`[ChromaDB] Server process exited during startup`);
          break;
        }

        if (await this._checkHeartbeat()) {
          console.log(`[ChromaDB] Server ready (waited ${waited}ms)`);
          this.chromaClient = new ChromaClient({
            host: 'localhost',
            port: this.chromaPort,
            ssl: false,
          } as Record<string, unknown>);
          return;
        }
      }

      if (this.chromaProcess) {
        this.chromaProcess.kill('SIGKILL');
        this.chromaProcess = null;
      }
      await this._killPortProcess();
    }

    throw new Error(
      `ChromaDB server failed to start after ${maxAttempts} attempts on port ${this.chromaPort}`
    );
  }

  async init(): Promise<void> {
    if (!this.embedder) {
      console.log('[Transformer Memory] Loading feature-extraction pipeline...');
      this.embedder = (await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      )) as unknown as Pipeline;
      console.log('[Transformer Memory] Pipeline loaded.');
    }
    if (!this.collection) {
      try {
        await this._ensureChromaServer();

        const origWarn = console.warn;
        const origErr = console.error;
        const suppress = (...args: unknown[]) => {
          const msg = args.join(' ');
          if (
            msg.includes('DefaultEmbeddingFunction') ||
            msg.includes('default-embed')
          )
            return;
          origErr.call(console, ...args);
        };
        console.warn = suppress;
        console.error = suppress;
        try {
          this.collection = await this.chromaClient!.getOrCreateCollection({
            name: this.collectionName,
            metadata: { 'hnsw:space': 'cosine' },
            embeddingFunction: null as unknown as undefined,
          });
        } finally {
          console.warn = origWarn;
          console.error = origErr;
        }
        console.log(
          `[Transformer Memory] Connected to ChromaDB collection: ${this.collectionName}`
        );
      } catch (error) {
        console.error(
          '[Transformer Memory] Failed to connect to ChromaDB:',
          error
        );
        throw error;
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.chromaProcess) {
      console.log('[ChromaDB] Shutting down server...');
      const proc = this.chromaProcess;
      this.chromaProcess = null;

      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch (_e) {
            // ignore
          }
          resolve();
        }, 5000);
        proc.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      console.log('[ChromaDB] Server stopped.');
    }
    this.collection = null;
    this.chromaClient = null;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const output = await this.embedder!(text, {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }

  async addMemory(
    agentId: string,
    content: string,
    type: string = 'semantic',
    importance: number = 3
  ): Promise<string> {
    await this.init();
    const embedding = await this.getEmbedding(content);
    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const metadata: Record<string, string | number | boolean> = {
      agentId: agentId || 'system',
      type,
      timestamp: now,
      importance,
      accessCount: 0,
      lastAccessed: now,
      connections: JSON.stringify([]),
    };

    if (type === 'semantic') {
      const results = await this.collection!.query({
        queryEmbeddings: [embedding],
        nResults: 1,
        where: {
          $and: [
            { type: 'semantic' },
            { agentId: agentId || 'system' },
          ],
        } as any,
      });

      if (results.ids[0] && results.ids[0].length > 0) {
        const existingId = results.ids[0][0];
        const existingDistance = results.distances![0][0]!;
        const sim = 1 - existingDistance;

        if (sim > 0.92) {
          const existingMetadata = results.metadatas![0][0] as Record<string, string | number | boolean>;
          const existingContent = results.documents![0][0] as string;

          existingMetadata.lastAccessed = now;
          existingMetadata.accessCount =
            ((existingMetadata.accessCount as number) || 0) + 1;
          existingMetadata.importance = Math.min(
            5,
            ((existingMetadata.importance as number) || 3) + 1
          );

          let newContent = existingContent;
          let newEmbedding = embedding;

          if (!existingContent.includes(content)) {
            newContent += `\n[补充]: ${content}`;
            newEmbedding = await this.getEmbedding(newContent);
          }

          await this.collection!.update({
            ids: [existingId],
            embeddings: [newEmbedding],
            metadatas: [existingMetadata],
            documents: [newContent],
          });

          console.log(
            `[Transformer Memory] Consolidated into existing memory ${existingId}`
          );
          return existingId;
        }
      }
    }

    const connections = await this._buildConnections(embedding, id);
    metadata.connections = JSON.stringify(connections);

    await this.collection!.add({
      ids: [id],
      embeddings: [embedding],
      metadatas: [metadata],
      documents: [content],
    });

    return id;
  }

  async _buildConnections(
    newEmbedding: number[],
    newId: string
  ): Promise<string[]> {
    const connections: string[] = [];
    try {
      const results = await this.collection!.query({
        queryEmbeddings: [newEmbedding],
        nResults: 3,
      });

      if (results.ids[0] && results.ids[0].length > 0) {
        for (let i = 0; i < results.ids[0].length; i++) {
          const targetId = results.ids[0][i];
          if (targetId === newId) continue;

          const distance = results.distances![0][i]!;
          const sim = 1 - distance;

          if (sim > 0.75) {
            connections.push(targetId);

            const targetMetadata = results.metadatas![0][i] as Record<string, string | number | boolean>;
            let targetConnections: string[] = [];
            try {
              targetConnections = JSON.parse(
                (targetMetadata.connections as string) || '[]'
              );
            } catch (_e) {
              // ignore
            }

            if (!targetConnections.includes(newId)) {
              targetConnections.push(newId);
              targetMetadata.connections =
                JSON.stringify(targetConnections);

              await this.collection!.update({
                ids: [targetId],
                metadatas: [targetMetadata],
              });
            }
          }
        }
      }
    } catch (error) {
      console.error(
        '[Transformer Memory] Error building connections:',
        error
      );
    }
    return connections;
  }

  async retrieve(
    agentId: string,
    query: string,
    limit: number = 5
  ): Promise<MemoryResult[]> {
    await this.init();

    const queryEmbedding = await this.getEmbedding(query);
    const now = Date.now();

    const fetchLimit = Math.max(limit * 3, 20);
    const whereClause = agentId ? { agentId } : undefined;

    let results: any;
    try {
      results = await this.collection!.query({
        queryEmbeddings: [queryEmbedding],
        nResults: fetchLimit,
        where: whereClause as any,
      });
    } catch (error) {
      console.error(
        '[Transformer Memory] Error querying ChromaDB:',
        error
      );
      return [];
    }

    const ids = (results as Record<string, unknown[][]>).ids;
    const documents = (results as Record<string, unknown[][]>).documents;
    const metadatas = (results as Record<string, unknown[][]>).metadatas;
    const distances = (results as Record<string, (number | null)[][]>).distances;

    if (!ids[0] || ids[0].length === 0) return [];

    const candidates: MemoryCandidate[] = [];
    for (let i = 0; i < ids[0].length; i++) {
      candidates.push({
        id: ids[0][i] as string,
        content: documents[0][i] as string,
        metadata: metadatas[0][i] as unknown as MemoryMetadata,
        distance: (distances[0][i] ?? 0) as number,
      });
    }

    const rawScores: ScoredMemory[] = candidates.map((m) => {
      const dotProduct = 1 - m.distance;
      const scaledAttention = dotProduct / Math.sqrt(this.dimension);

      const ageDays =
        (now - ((m.metadata.timestamp as number) || now)) /
        (1000 * 60 * 60 * 24);
      const timeDecay = Math.exp(-0.05 * ageDays);

      const importanceWeight =
        1 + (((m.metadata.importance as number) || 3) * 0.1);
      const frequencyWeight =
        1 +
        Math.log1p((m.metadata.accessCount as number) || 0) * 0.05;

      const finalScore =
        scaledAttention * timeDecay * importanceWeight * frequencyWeight;

      return { memory: m, score: finalScore, scaledAttention, timeDecay };
    });

    const maxScore = Math.max(...rawScores.map((r) => r.score));
    const expScores = rawScores.map((r) => ({
      ...r,
      exp: Math.exp(r.score - maxScore),
    }));
    const sumExp = expScores.reduce((sum, r) => sum + r.exp!, 0);

    const attentionResults = expScores
      .map((r) => ({
        ...r,
        attentionWeight: r.exp! / sumExp,
      }))
      .sort((a, b) => b.attentionWeight! - a.attentionWeight!);

    const topResults = attentionResults.slice(0, limit);
    const expandedResults = new Map<string, ScoredMemory>();

    for (const res of topResults) {
      expandedResults.set(res.memory.id, res);

      let connections: string[] = [];
      try {
        connections = JSON.parse(
          (res.memory.metadata.connections as string) || '[]'
        );
      } catch (_e) {
        // ignore
      }

      for (const connId of connections) {
        if (!expandedResults.has(connId)) {
          try {
            const connResult = await this.collection!.get({
              ids: [connId],
            });

            if (connResult.ids && connResult.ids.length > 0) {
              const connMem: MemoryCandidate = {
                id: connResult.ids[0],
                content: connResult.documents![0] as string,
                metadata: connResult.metadatas![0] as unknown as MemoryMetadata,
                distance: 0,
              };

              expandedResults.set(connId, {
                memory: connMem,
                score: 0,
                scaledAttention: 0,
                attentionWeight: res.attentionWeight! * 0.5,
                isRelational: true,
                timeDecay: 1,
              });
            }
          } catch (_e) {
            console.error(
              `[Transformer Memory] Failed to fetch connected memory ${connId}`
            );
          }
        }
      }
    }

    const finalResults = Array.from(expandedResults.values())
      .sort((a, b) => (b.attentionWeight || 0) - (a.attentionWeight || 0))
      .slice(0, limit);

    for (const res of finalResults) {
      (res.memory.metadata as any).accessCount =
        ((res.memory.metadata.accessCount as number) || 0) + 1;
      (res.memory.metadata as any).lastAccessed = now;

      try {
        await this.collection!.update({
          ids: [res.memory.id],
          metadatas: [res.memory.metadata as any],
        });
      } catch (_e) {
        console.error(
          `[Transformer Memory] Failed to update access stats for ${res.memory.id}`
        );
      }
    }

    return finalResults.map((r) => ({
      content: r.memory.content,
      type: r.memory.metadata.type as string,
      attentionWeight: r.attentionWeight || 0,
      metrics: {
        timeDecay: r.timeDecay,
        isRelational: r.isRelational || false,
      },
      metadata: r.memory.metadata as unknown as Record<string, unknown>,
    }));
  }

  async cleanup(
    daysOld: number = 30,
    maxImportanceToForget: number = 2
  ): Promise<number> {
    await this.init();
    const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;

    try {
      const allResults = await this.collection!.get();

      if (!allResults.ids || allResults.ids.length === 0) return 0;

      const idsToDelete: string[] = [];

      for (let i = 0; i < allResults.ids.length; i++) {
        const metadata = allResults.metadatas![i] as Record<string, unknown>;

        const isOld = ((metadata.lastAccessed as number) || 0) < cutoffTime;
        const isUnimportant =
          ((metadata.importance as number) || 3) <= maxImportanceToForget;

        if (isOld && isUnimportant) {
          idsToDelete.push(allResults.ids[i]);
        }
      }

      if (idsToDelete.length > 0) {
        await this.collection!.delete({
          ids: idsToDelete,
        });

        console.log(
          `[Transformer Memory] Forgot ${idsToDelete.length} old/unimportant memories.`
        );
      }

      return idsToDelete.length;
    } catch (error) {
      console.error(
        '[Transformer Memory] Error during cleanup:',
        error
      );
      return 0;
    }
  }
}

export const memorySystem = new TransformerMemorySystem();
