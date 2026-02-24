import fs from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type { ChatMessage } from './types.js';

/**
 * 辅助函数：读取文件
 */
async function readFile(relativePath: string): Promise<string | null> {
  try {
    const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
    return await fs.readFile(fullPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 辅助函数：写入文件
 */
async function writeFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * 辅助函数：追加文件
 */
async function appendFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, content, 'utf-8');
}

/**
 * 辅助函数：列出目录
 */
async function listDir(relativePath: string): Promise<string[]> {
  try {
    const fullPath = path.join(MIDOU_WORKSPACE_DIR, relativePath);
    return await fs.readdir(fullPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * 获取今天的日期字符串
 */
export function today(): string {
  return dayjs().format('YYYY-MM-DD');
}

/**
 * 获取今日日记的路径
 */
export function todayJournalPath(agentName?: string | null): string {
  if (agentName) {
    return `agents/${agentName}/memory/${today()}.md`;
  }
  return `memory/${today()}.md`;
}

/**
 * 写入今日日记（追加）
 */
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

/**
 * 记录一次对话到日记
 */
export async function logConversation(
  agentName: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const time = dayjs().format('HH:mm');
  const entry = `### ${time}\n\n**用户**: ${userMessage}\n\n**${agentName}**: ${assistantMessage}\n`;
  await writeJournal(entry, agentName);
}

/**
 * 读取最近几天的日记（带长度限制）
 */
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

/**
 * 获取所有日记文件列表
 */
export async function listJournals(): Promise<string[]> {
  const files = await listDir('memory');
  return files.filter((f) => f.endsWith('.md')).sort().reverse();
}

/**
 * 会话记忆管理器 — 管理当前会话中的对话历史
 */
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
