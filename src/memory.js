/**
 * 记忆系统 — midou 延续自我的方式
 * 
 * 两层记忆架构：
 * - 日记 (memory/YYYY-MM-DD.md): 每日对话记录，追加式
 * - 长期记忆 (MEMORY.md): 从日记中提炼的重要信息
 */

import dayjs from 'dayjs';
import { readFile, writeFile, appendFile, listDir } from './soul.js';

/**
 * 获取今天的日期字符串
 */
export function today() {
  return dayjs().format('YYYY-MM-DD');
}

/**
 * 获取今日日记的路径
 */
export function todayJournalPath() {
  return `memory/${today()}.md`;
}

/**
 * 写入今日日记（追加）
 */
export async function writeJournal(content) {
  const journalPath = todayJournalPath();
  const existing = await readFile(journalPath);

  if (!existing) {
    // 创建新的日记，带标题
    const header = `# ${today()} 日记\n\n`;
    await writeFile(journalPath, header + content + '\n\n');
  } else {
    await appendFile(journalPath, content + '\n\n');
  }
}

/**
 * 记录一次对话到日记
 */
export async function logConversation(userMessage, assistantMessage) {
  const time = dayjs().format('HH:mm');
  const entry = `### ${time}\n\n**主人**: ${userMessage}\n\n**midou**: ${assistantMessage}\n`;
  await writeJournal(entry);
}

/**
 * 读取最近几天的日记
 */
export async function getRecentMemories(days = 2) {
  const memories = [];

  for (let i = 0; i < days; i++) {
    const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
    const journal = await readFile(`memory/${date}.md`);
    if (journal) {
      memories.push(journal);
    }
  }

  return memories.join('\n\n---\n\n');
}

/**
 * 读取长期记忆
 */
export async function getLongTermMemory() {
  return await readFile('MEMORY.md') || '';
}

/**
 * 写入长期记忆（追加一条新记忆）
 */
export async function addLongTermMemory(content) {
  const timestamp = dayjs().format('YYYY-MM-DD HH:mm');
  const entry = `\n### ${timestamp}\n\n${content}\n`;
  await appendFile('MEMORY.md', entry);
}

/**
 * 获取所有日记文件列表
 */
export async function listJournals() {
  const files = await listDir('memory');
  return files
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();
}

/**
 * 会话记忆管理器 — 管理当前会话中的对话历史
 */
export class SessionMemory {
  constructor(maxMessages = 50) {
    this.messages = [];
    this.maxMessages = maxMessages;
  }

  add(role, content) {
    this.messages.push({ role, content });

    // 如果消息过多，保留系统消息和最近的对话
    if (this.messages.length > this.maxMessages) {
      const systemMsg = this.messages.find(m => m.role === 'system');
      const recent = this.messages.slice(-this.maxMessages + 1);
      this.messages = systemMsg ? [systemMsg, ...recent] : recent;
    }
  }

  getMessages() {
    return [...this.messages];
  }

  clear() {
    const systemMsg = this.messages.find(m => m.role === 'system');
    this.messages = systemMsg ? [systemMsg] : [];
  }
}
