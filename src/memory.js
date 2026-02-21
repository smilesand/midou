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
 * 读取最近几天的日记（带长度限制）
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

  const combined = memories.join('\n\n---\n\n');
  
  // 限制长度，只保留最近的部分（假设越靠后越新）
  const MAX_JOURNAL_LENGTH = 5000;
  if (combined.length > MAX_JOURNAL_LENGTH) {
    return '…' + combined.slice(-MAX_JOURNAL_LENGTH);
  }
  
  return combined;
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
 *
 * 改进的记忆策略：
 *   1. 更大的消息窗口（100 条）
 *   2. 滑动时生成上下文摘要，避免上下文断裂
 *   3. 工具调用链在压缩时被折叠为摘要
 *   4. 保留系统消息 + 摘要 + 最近对话
 */
export class SessionMemory {
  constructor(maxMessages = 80) {
    this.messages = [];
    this.maxMessages = maxMessages;
    this.contextSummary = '';   // 被压缩掉的对话的摘要
    this.totalTurns = 0;        // 总对话轮数
  }

  /**
   * 添加消息（支持完整消息对象，用于工具调用链）
   */
  add(roleOrMsg, content) {
    // 避免重复添加完全相同的消息对象
    if (typeof roleOrMsg === 'object' && this.messages.includes(roleOrMsg)) {
      return;
    }

    if (typeof roleOrMsg === 'object') {
      this.messages.push(roleOrMsg);
    } else {
      this.messages.push({ role: roleOrMsg, content });
    }

    if (roleOrMsg === 'user' || (typeof roleOrMsg === 'object' && roleOrMsg.role === 'user')) {
      this.totalTurns++;
    }

    // 当消息过多时，进行智能压缩
    if (this.messages.length > this.maxMessages) {
      this._compress();
    }
  }

  getMessages() {
    // 始终从原始消息列表开始，不污染原始数据
    let msgs = [...this.messages];

    // 如果消息还是太多（防御性检查），只保留最近的
    if (msgs.length > this.maxMessages + 10) {
      const systemMsg = msgs.find(m => m.role === 'system');
      const nonSystem = msgs.filter(m => m.role !== 'system');
      msgs = systemMsg 
        ? [systemMsg, ...nonSystem.slice(-this.maxMessages)]
        : nonSystem.slice(-this.maxMessages);
    }

    // 如果有上下文摘要，注入到系统消息后面
    if (this.contextSummary && msgs.length > 0 && msgs[0].role === 'system') {
      const summaryMsg = {
        role: 'user',
        content: `[对话上下文摘要 — 以下是之前对话的要点]\n${this.contextSummary}`,
      };
      const assistantAck = {
        role: 'assistant',
        content: '我已收到上下文摘要，会保持对话连贯性。',
      };
      // 避免重复注入（如果 msgs 已经是被污染过的）
      if (msgs[1]?.content?.includes('[对话上下文摘要')) {
        return msgs;
      }
      return [msgs[0], summaryMsg, assistantAck, ...msgs.slice(1)];
    }
    return msgs;
  }

  clear() {
    const systemMsg = this.messages.find(m => m.role === 'system');
    this.messages = systemMsg ? [systemMsg] : [];
    this.contextSummary = '';
  }

  /**
   * 移除最后一条消息
   */
  removeLast() {
    if (this.messages.length > 0) {
      const last = this.messages.pop();
      if (last.role === 'user') {
        this.totalTurns--;
      }
      return last;
    }
    return null;
  }

  /**
   * 智能压缩：保留系统消息和最近对话，压缩中间部分为摘要
   */
  _compress() {
    const systemMsg = this.messages.find(m => m.role === 'system');
    const nonSystem = this.messages.filter(m => m.role !== 'system');

    // 保留最近 60% 的消息（更激进一点）
    const keepCount = Math.floor(this.maxMessages * 0.6);
    const dropMessages = nonSystem.slice(0, nonSystem.length - keepCount);
    const keepMessages = nonSystem.slice(nonSystem.length - keepCount);

    // 从被丢弃的消息中生成摘要
    const summary = this._summarizeMessages(dropMessages);
    if (summary) {
      this.contextSummary = (this.contextSummary ? this.contextSummary + '\n\n' : '') + summary;
      // 限制摘要长度
      if (this.contextSummary.length > 3000) {
        this.contextSummary = '…' + this.contextSummary.slice(-3000);
      }
    }

    this.messages = systemMsg ? [systemMsg, ...keepMessages] : keepMessages;
  }

  /**
   * 从消息列表中提取摘要
   */
  _summarizeMessages(messages) {
    const points = [];
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content && typeof msg.content === 'string') {
        const short = msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
        points.push(`- 用户: ${short}`);
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls) {
          const names = msg.tool_calls.map(tc => tc.function.name).join(', ');
          points.push(`- midou 使用了工具: ${names}`);
        } else if (msg.content && typeof msg.content === 'string') {
          const short = msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
          points.push(`- midou: ${short}`);
        }
      } else if (msg.role === 'tool') {
        // 工具结果通常比较大，只记录成功/失败
        const short = String(msg.content).length > 50 ? String(msg.content).slice(0, 50) + '…' : msg.content;
        points.push(`  ↳ 工具结果: ${short}`);
      }
    }
    return points.length > 0 ? points.join('\n') : '';
  }
}
