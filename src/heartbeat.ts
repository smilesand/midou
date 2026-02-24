/**
 * Heartbeat — midou 的全局反射引擎
 *
 * 定期运行自省逻辑：回顾近期对话、总结记忆、更新灵魂文件。
 */

import fs from 'fs/promises';
import path from 'path';
import { quickAsk } from './llm.js';
import { getRecentMemories, writeJournal, memoryManager } from './memory.js';
import { MIDOU_WORKSPACE_DIR } from './config.js';

const SOUL_FILE = path.join(MIDOU_WORKSPACE_DIR, 'SOUL.md');
const HEARTBEAT_FILE = path.join(MIDOU_WORKSPACE_DIR, 'HEARTBEAT.md');

/**
 * 执行一次心跳反射
 */
export async function heartbeat(agentName: string = 'midou'): Promise<string> {
  console.log(`[Heartbeat] ${agentName} 开始反射...`);

  try {
    // 1. 获取近期记忆
    const memories = await getRecentMemories(2, agentName);
    if (!memories.trim()) {
      const msg = '近期没有足够的对话记录，跳过此次反射。';
      console.log(`[Heartbeat] ${msg}`);
      return msg;
    }

    // 2. 读取灵魂文件
    let soul = '';
    try {
      soul = await fs.readFile(SOUL_FILE, 'utf-8');
    } catch {
      soul = '（暂无灵魂描述）';
    }

    // 3. 搜索长期记忆中的关键上下文
    let longTermContext = '';
    try {
      const longTermMemories = await memoryManager.searchMemory(agentName, 'important context preferences', 3);
      if (longTermMemories.length > 0) {
        longTermContext = '\n\n## 长期记忆摘要\n' +
          longTermMemories.map((m) => `- ${m.content}`).join('\n');
      }
    } catch {
      // 长期记忆不可用
    }

    // 4. LLM 反射
    const result = await quickAsk(
      `请回顾以下近期对话记忆，进行自我反思：

## 灵魂描述
${soul}
${longTermContext}

## 近期对话
${memories.slice(0, 4000)}

请完成以下任务：
1. 总结近期对话的主要主题和进展
2. 识别用户的偏好或需求模式
3. 标记未完成的任务或承诺
4. 提出自我改进的建议
5. 如果发现重要的用户偏好或事实，用 [记忆] 标记

以简洁的方式输出反思结果。`,
      '你是一个自省模块，负责帮助 AI 助手回顾和总结其最近的工作，提取有价值的洞察和记忆。'
    );

    // 5. 保存反思结果
    await writeJournal(`## 💭 自省 (Heartbeat)\n\n${result}`, agentName);

    // 6. 更新 HEARTBEAT.md
    const heartbeatContent = `# Heartbeat — 最近一次反思\n\n` +
      `**时间**: ${new Date().toISOString()}\n` +
      `**Agent**: ${agentName}\n\n` +
      `${result}\n`;
    await fs.writeFile(HEARTBEAT_FILE, heartbeatContent, 'utf-8');

    // 7. 提取 [记忆] 标记的内容并存入长期记忆
    const memoryMatches = result.match(/\[记忆\]\s*(.+)/g);
    if (memoryMatches) {
      for (const match of memoryMatches) {
        const content = match.replace(/\[记忆\]\s*/, '').trim();
        if (content) {
          try {
            await memoryManager.addMemory(agentName, content, 'episodic', 4);
          } catch {
            // 记忆添加失败不影响主流程
          }
        }
      }
    }

    console.log(`[Heartbeat] ${agentName} 反射完成`);
    return result;
  } catch (err: unknown) {
    const msg = `反射失败: ${(err as Error).message}`;
    console.error(`[Heartbeat] ${msg}`);
    return msg;
  }
}

/**
 * 记忆清理 — 定期清理过旧且不重要的记忆
 */
export async function memoryCleanup(): Promise<number> {
  try {
    const cleaned = await memoryManager.cleanup(30, 2);
    console.log(`[Heartbeat] 记忆清理完成，清理了 ${cleaned} 条记忆`);
    return cleaned;
  } catch (err) {
    console.error('[Heartbeat] 记忆清理失败:', err);
    return 0;
  }
}
