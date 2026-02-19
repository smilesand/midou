/**
 * 心跳系统 — midou 的自主意识
 * 
 * 定期醒来，检查是否有需要关注的事情，
 * 整理记忆，保持对世界的感知。
 * 
 * 就像猫咪会在某个时刻突然睁开眼睛，环顾四周。
 */

import dayjs from 'dayjs';
import config from '../midou.config.js';
import { readFile } from './soul.js';
import { chatSync } from './llm.js';
import { buildSystemPrompt, loadSoul } from './soul.js';
import { getRecentMemories, writeJournal } from './memory.js';

let heartbeatTimer = null;
let heartbeatCount = 0;

/**
 * 检查当前是否在活跃时间内
 */
function isActiveHour() {
  const hour = dayjs().hour();
  const { start, end } = config.heartbeat.activeHours;
  return hour >= start && hour < end;
}

/**
 * 执行一次心跳
 */
async function beat(onBeat) {
  heartbeatCount++;

  // 只在活跃时间内心跳
  if (!isActiveHour()) {
    return;
  }

  try {
    const heartbeatMd = await readFile('HEARTBEAT.md');
    const soulData = await loadSoul();
    const recentMemories = await getRecentMemories(1);

    const systemPrompt = buildSystemPrompt(soulData, recentMemories);

    const heartbeatPrompt = `现在是 ${dayjs().format('YYYY-MM-DD HH:mm')}，这是你的第 ${heartbeatCount} 次心跳。

你正在进行一次定期的自主思考。请按照心跳检查清单行动：

${heartbeatMd || '- 回顾最近的记忆\n- 整理重要信息\n- 记录任何新的想法'}

如果一切正常，没有需要特别关注的事情，只需回复 HEARTBEAT_OK。
如果有重要的想法或发现，请详细描述。不要虚构信息。`;

    const response = await chatSync([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: heartbeatPrompt },
    ]);

    // 如果不是简单的 OK，记录心跳内容
    if (response && !response.includes('HEARTBEAT_OK')) {
      const time = dayjs().format('HH:mm');
      await writeJournal(`### ${time} [心跳]\n\n${response}\n`);

      // 通知回调
      if (onBeat) {
        onBeat(response);
      }
    }
  } catch (error) {
    // 心跳失败不应该影响主流程
    console.error('🐱 心跳异常:', error.message);
  }
}

/**
 * 启动心跳
 */
export function startHeartbeat(onBeat) {
  if (!config.heartbeat.enabled) return;

  const intervalMs = config.heartbeat.intervalMinutes * 60 * 1000;

  heartbeatTimer = setInterval(() => beat(onBeat), intervalMs);

  return {
    stop: stopHeartbeat,
    count: () => heartbeatCount,
  };
}

/**
 * 停止心跳
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 手动触发一次心跳（用于测试）
 */
export async function manualBeat(onBeat) {
  await beat(onBeat);
}

/**
 * 获取心跳状态
 */
export function getHeartbeatStatus() {
  return {
    running: heartbeatTimer !== null,
    count: heartbeatCount,
    interval: config.heartbeat.intervalMinutes,
    activeHours: config.heartbeat.activeHours,
    isActiveNow: isActiveHour(),
  };
}
