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
import { writeJournal } from './memory.js';
import { getHeartbeatParams } from './mode.js';

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

    // 心跳用轻量系统提示词（只保留灵魂核心 + 用户信息）
    const hbParams = getHeartbeatParams();
    const lightSystemPrompt = `你是 midou（咪豆），正在进行定期心跳检查。保持简洁。`;

    const heartbeatPrompt = `时间: ${dayjs().format('YYYY-MM-DD HH:mm')}，第 ${heartbeatCount} 次心跳。

检查清单：
${heartbeatMd || '- 回顾记忆\n- 整理信息'}

一切正常回复 HEARTBEAT_OK。有想法则简短描述。不要虚构。`;

    const response = await chatSync([
      { role: 'system', content: lightSystemPrompt },
      { role: 'user', content: heartbeatPrompt },
    ], { maxTokens: hbParams.maxTokens });

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
