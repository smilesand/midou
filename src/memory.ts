/**
 * 记忆系统 — 会话记忆管理 + 日记系统 + 记忆提供者管理
 */

import fs from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type { ChatMessage, MemoryProvider, MemoryResult } from './types.js';

// ═══════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════

async function readFile(relativePath: string): Promise<string | null> {
  try {
    const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
    return await fs.readFile(fullPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

async function appendFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, content, 'utf-8');
}

async function listDir(relativePath: string): Promise<string[]> {
  try {
    const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
    return await fs.readdir(fullPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

// ═══════════════════════════════════════════
// 日记系统（文件记录）
// ═══════════════════════════════════════════

export function today(): string {
  return dayjs().format('YYYY-MM-DD');
}

export function todayJournalPath(agentName?: string | null): string {
  if (agentName) {
    return `agents/${agentName}/memory/${today()}.md`;
  }
  return `memory/${today()}.md`;
}

export async function writeJournal(
  content: string,
  agentName: string | null = null
): Promise<void> {
  const journalPath = todayJournalPath(agentName);
  const existing = await readFile(journalPath);

  if (!existing) {
    const header = `# ${today()} 日记\n\n`;
    await writeFile(journalPath, header + content + '\n\n');
  } else {
    await appendFile(journalPath, content + '\n\n');
  }
}

export async function logConversation(
  agentName: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const time = dayjs().format('HH:mm');
  const entry = `### ${time}\n\n**用户**: ${userMessage}\n\n**${agentName}**: ${assistantMessage}\n`;
  await writeJournal(entry, agentName);
}

export async function getRecentMemories(
  days: number = 2,
  agentName: string | null = null
): Promise<string> {
  const memories: string[] = [];

  for (let i = 0; i < days; i++) {
    const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
    const filePath = agentName
      ? `agents/${agentName}/memory/${date}.md`
      : `memory/${date}.md`;
    const journal = await readFile(filePath);
    if (journal) {
      memories.push(journal);
    }
  }

  const combined = memories.join('\n\n---\n\n');

  const MAX_JOURNAL_LENGTH = 5000;
  if (combined.length > MAX_JOURNAL_LENGTH) {
    return '…' + combined.slice(-MAX_JOURNAL_LENGTH);
  }

  return combined;
}

export async function listJournals(): Promise<string[]> {
  const files = await listDir('memory');
  return files.filter((f) => f.endsWith('.md')).sort().reverse();
}

// ═══════════════════════════════════════════
// 文件记忆提供者（默认实现）
// ═══════════════════════════════════════════

/**
 * 基于文件系统的简单记忆提供者 — 默认内置实现
 *
 * 使用 JSON 文件存储记忆，支持基于关键词的简单搜索。
 * 不依赖任何外部服务，适用于轻量级部署。
 */
export class FileMemoryProvider implements MemoryProvider {
  readonly name = 'file';
  private memoriesDir: string;

  constructor() {
    this.memoriesDir = path.join(MIDOU_WORKSPACE_DIR, 'memories');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.memoriesDir, { recursive: true });
  }

  async shutdown(): Promise<void> {
    // 文件系统不需要关闭
  }

  async addMemory(
    agentId: string,
    content: string,
    type: string = 'semantic',
    importance: number = 3
  ): Promise<string> {
    const agentDir = path.join(this.memoriesDir, agentId);
    await fs.mkdir(agentDir, { recursive: true });

    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id,
      content,
      type,
      importance,
      confidence: 1.0,
      status: 'active',
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
    };

    const filePath = path.join(agentDir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');

    return id;
  }

  async searchMemory(
    agentId: string,
    query: string,
    limit: number = 5
  ): Promise<MemoryResult[]> {
    const agentDir = path.join(this.memoriesDir, agentId);
    let files: string[];
    try {
      files = await fs.readdir(agentDir);
    } catch {
      return [];
    }

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const results: Array<{ entry: Record<string, unknown>; score: number }> = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(agentDir, file), 'utf-8');
        const entry = JSON.parse(data) as Record<string, unknown>;
        if (entry.status === 'deprecated') continue;

        const content = String(entry.content || '').toLowerCase();
        // 简单的关键词匹配评分
        let matchScore = 0;
        for (const word of queryWords) {
          if (content.includes(word)) {
            matchScore += 1;
          }
        }

        if (matchScore > 0) {
          // 时间衰减
          const ageHours = (Date.now() - (entry.createdAt as number)) / 3600000;
          const timeDecay = Math.exp(-ageHours / (24 * 30)); // 30 天半衰期
          const importance = (entry.importance as number) || 3;
          const confidence = (entry.confidence as number) || 1.0;

          const score = matchScore * confidence * (importance / 5) * (0.5 + 0.5 * timeDecay);
          results.push({ entry, score });
        }
      } catch {
        // 跳过无法解析的文件
      }
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map((r) => ({
      content: String(r.entry.content),
      type: String(r.entry.type || 'semantic'),
      attentionWeight: Math.min(r.score / 3, 1.0),
      metrics: {
        timeDecay: Math.exp(-(Date.now() - (r.entry.createdAt as number)) / (3600000 * 24 * 30)),
        isRelational: false,
      },
      metadata: r.entry as Record<string, unknown>,
    }));
  }

  async cleanup(daysOld: number = 30, maxImportanceToForget: number = 2): Promise<number> {
    const threshold = Date.now() - daysOld * 24 * 3600 * 1000;
    let cleaned = 0;

    let agentDirs: string[];
    try {
      agentDirs = await fs.readdir(this.memoriesDir);
    } catch {
      return 0;
    }

    for (const agentDir of agentDirs) {
      const dirPath = path.join(this.memoriesDir, agentDir);
      let files: string[];
      try {
        files = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(dirPath, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const entry = JSON.parse(data) as Record<string, unknown>;

          if (
            (entry.createdAt as number) < threshold &&
            (entry.importance as number) <= maxImportanceToForget &&
            (entry.accessCount as number || 0) < 3
          ) {
            entry.status = 'deprecated';
            await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
            cleaned++;
          }
        } catch {
          // 跳过
        }
      }
    }

    return cleaned;
  }
}

// ═══════════════════════════════════════════
// 记忆管理器（统一门面）
// ═══════════════════════════════════════════

/**
 * 记忆管理器 — 管理多个记忆提供者，提供统一的记忆操作入口
 */
export class MemoryManager {
  private providers: Map<string, MemoryProvider> = new Map();
  private _defaultProvider: string = 'file';

  /**
   * 注册记忆提供者
   */
  register(provider: MemoryProvider): void {
    this.providers.set(provider.name, provider);
    console.log(`[Memory] 已注册记忆提供者: ${provider.name}`);
  }

  /**
   * 设置默认提供者
   */
  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      console.warn(`[Memory] 提供者 "${name}" 未注册，保持当前默认: ${this._defaultProvider}`);
      return;
    }
    this._defaultProvider = name;
    console.log(`[Memory] 默认记忆提供者已切换为: ${name}`);
  }

  /**
   * 获取指定提供者（不指定则返回默认提供者）
   */
  getProvider(name?: string): MemoryProvider | undefined {
    return this.providers.get(name || this._defaultProvider);
  }

  /**
   * 初始化所有提供者
   */
  async init(): Promise<void> {
    for (const [name, provider] of this.providers) {
      try {
        await provider.init();
        console.log(`[Memory] 提供者 "${name}" 初始化成功`);
      } catch (err) {
        console.error(`[Memory] 提供者 "${name}" 初始化失败:`, err);
      }
    }
  }

  /**
   * 关闭所有提供者
   */
  async shutdown(): Promise<void> {
    for (const [name, provider] of this.providers) {
      try {
        await provider.shutdown();
      } catch (err) {
        console.error(`[Memory] 提供者 "${name}" 关闭失败:`, err);
      }
    }
  }

  /**
   * 存入记忆（广播到所有提供者）
   */
  async addMemory(
    agentId: string,
    content: string,
    type: string = 'semantic',
    importance: number = 3
  ): Promise<string> {
    const results: string[] = [];
    for (const [, provider] of this.providers) {
      try {
        const id = await provider.addMemory(agentId, content, type, importance);
        results.push(id);
      } catch (err) {
        console.error(`[Memory] 提供者 "${provider.name}" addMemory 失败:`, err);
      }
    }
    return results[0] || '';
  }

  /**
   * 搜索记忆（聚合所有提供者的结果）
   */
  async searchMemory(
    agentId: string,
    query: string,
    limit: number = 5
  ): Promise<MemoryResult[]> {
    const allResults: MemoryResult[] = [];

    for (const [, provider] of this.providers) {
      try {
        const results = await provider.searchMemory(agentId, query, limit);
        allResults.push(...results);
      } catch (err) {
        console.error(`[Memory] 提供者 "${provider.name}" searchMemory 失败:`, err);
      }
    }

    // 按 attentionWeight 排序，去重，截取
    allResults.sort((a, b) => b.attentionWeight - a.attentionWeight);

    // 简单去重（基于内容前 100 字符）
    const seen = new Set<string>();
    const deduped = allResults.filter((r) => {
      const key = r.content.slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.slice(0, limit);
  }

  /**
   * 清理旧记忆（所有提供者）
   */
  async cleanup(daysOld: number = 30, maxImportanceToForget: number = 2): Promise<number> {
    let total = 0;
    for (const [, provider] of this.providers) {
      try {
        total += await provider.cleanup(daysOld, maxImportanceToForget);
      } catch (err) {
        console.error(`[Memory] 提供者 "${provider.name}" cleanup 失败:`, err);
      }
    }
    return total;
  }
}

// ── 全局单例 ──

export const memoryManager = new MemoryManager();

/**
 * 初始化记忆系统（注册默认的文件提供者）
 */
export async function initMemory(): Promise<void> {
  const fileProvider = new FileMemoryProvider();
  memoryManager.register(fileProvider);
  await memoryManager.init();
}

// ═══════════════════════════════════════════
// 会话记忆管理器
// ═══════════════════════════════════════════

export class SessionMemory {
  messages: ChatMessage[];
  maxMessages: number;
  contextSummary: string;
  totalTurns: number;

  constructor(maxMessages: number = 80) {
    this.messages = [];
    this.maxMessages = maxMessages;
    this.contextSummary = '';
    this.totalTurns = 0;
  }

  add(roleOrMsg: string | ChatMessage, content?: string): void {
    if (typeof roleOrMsg === 'object' && this.messages.includes(roleOrMsg)) {
      return;
    }

    if (typeof roleOrMsg === 'object') {
      this.messages.push(roleOrMsg);
    } else {
      this.messages.push({ role: roleOrMsg, content: content || '' });
    }

    if (
      roleOrMsg === 'user' ||
      (typeof roleOrMsg === 'object' && roleOrMsg.role === 'user')
    ) {
      this.totalTurns++;
    }

    if (this.messages.length > this.maxMessages) {
      this._compress();
    }
  }

  getMessages(): ChatMessage[] {
    let msgs = [...this.messages];

    if (msgs.length > this.maxMessages + 10) {
      const systemMsg = msgs.find((m) => m.role === 'system');
      const nonSystem = msgs.filter((m) => m.role !== 'system');
      msgs = systemMsg
        ? [systemMsg, ...nonSystem.slice(-this.maxMessages)]
        : nonSystem.slice(-this.maxMessages);
    }

    if (
      this.contextSummary &&
      msgs.length > 0 &&
      msgs[0].role === 'system'
    ) {
      const summaryMsg: ChatMessage = {
        role: 'user',
        content: `[对话上下文摘要 — 以下是之前对话的要点]\n${this.contextSummary}`,
      };
      const assistantAck: ChatMessage = {
        role: 'assistant',
        content: '我已收到上下文摘要，会保持对话连贯性。',
      };
      if (msgs[1]?.content?.includes('[对话上下文摘要')) {
        return msgs;
      }
      return [msgs[0], summaryMsg, assistantAck, ...msgs.slice(1)];
    }
    return msgs;
  }

  clear(): void {
    const systemMsg = this.messages.find((m) => m.role === 'system');
    this.messages = systemMsg ? [systemMsg] : [];
    this.contextSummary = '';
  }

  removeLast(): ChatMessage | null {
    if (this.messages.length > 0) {
      const last = this.messages.pop()!;
      if (last.role === 'user') {
        this.totalTurns--;
      }
      return last;
    }
    return null;
  }

  private _compress(): void {
    const systemMsg = this.messages.find((m) => m.role === 'system');
    const nonSystem = this.messages.filter((m) => m.role !== 'system');

    const keepCount = Math.floor(this.maxMessages * 0.6);
    const dropMessages = nonSystem.slice(0, nonSystem.length - keepCount);
    const keepMessages = nonSystem.slice(nonSystem.length - keepCount);

    const summary = this._summarizeMessages(dropMessages);
    if (summary) {
      this.contextSummary =
        (this.contextSummary ? this.contextSummary + '\n\n' : '') + summary;
      if (this.contextSummary.length > 3000) {
        this.contextSummary = '…' + this.contextSummary.slice(-3000);
      }
    }

    this.messages = systemMsg
      ? [systemMsg, ...keepMessages]
      : keepMessages;
  }

  private _summarizeMessages(messages: ChatMessage[]): string {
    const points: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content && typeof msg.content === 'string') {
        const short =
          msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
        points.push(`- 用户: ${short}`);
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls) {
          const names = msg.tool_calls.map((tc) => tc.function.name).join(', ');
          points.push(`- midou 使用了工具: ${names}`);
        } else if (msg.content && typeof msg.content === 'string') {
          const short =
            msg.content.length > 80
              ? msg.content.slice(0, 80) + '…'
              : msg.content;
          points.push(`- midou: ${short}`);
        }
      } else if (msg.role === 'tool') {
        const short =
          String(msg.content).length > 50
            ? String(msg.content).slice(0, 50) + '…'
            : msg.content;
        points.push(`  ↳ 工具结果: ${short}`);
      }
    }
    return points.length > 0 ? points.join('\n') : '';
  }
}
