import dayjs from 'dayjs';
import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';
import { getRecentMemories, addLongTermMemory, writeJournal } from './memory.js';
import { LLMClient } from './llm.js';

let heartbeatTimer = null;

/**
 * 检查当前是否在活跃时间内
 */
function isActiveHour() {
  const hour = dayjs().hour();
  // 默认活跃时间 8:00 - 23:00
  return hour >= 8 && hour < 23;
}

/**
 * 执行一次全局反省（心跳）
 */
export async function beat(systemManager) {
  if (!isActiveHour()) {
    return;
  }

  try {
    console.log(`[Heartbeat] 开始全局反省...`);
    
    // 读取最近的记忆
    const recentMemories = await getRecentMemories(1); // 读取今天的日记
    if (!recentMemories || recentMemories.trim() === '') {
      console.log(`[Heartbeat] 今日无新记忆，跳过反省。`);
      return;
    }

    // 读取 HEARTBEAT.md 策略
    let heartbeatStrategy = '- 回顾今天的对话，提取重要的事实、用户的偏好或未完成的任务。\n- 总结成简短的长期记忆。';
    try {
      const strategyPath = path.join(MIDOU_WORKSPACE_DIR, 'HEARTBEAT.md');
      const content = await fs.readFile(strategyPath, 'utf-8');
      if (content) heartbeatStrategy = content;
    } catch (e) {
      // 忽略文件不存在
    }

    const systemPrompt = `你是系统的全局反省引擎。你的任务是阅读最近的对话记录，并根据反省策略提取有价值的信息，转化为长期记忆。保持客观、简洁。`;
    
    const prompt = `时间: ${dayjs().format('YYYY-MM-DD HH:mm')}
反省策略：
${heartbeatStrategy}

最近的对话记录：
${recentMemories}

请根据策略进行反省。如果没有值得记录的长期记忆，请回复 "NO_REFLECTION_NEEDED"。如果有，请直接输出需要保存的长期记忆内容。`;

    // 使用默认的 LLM 配置
    const llmClient = new LLMClient();
    const response = await llmClient.chatSync([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ]);

    if (response && !response.includes('NO_REFLECTION_NEEDED')) {
      console.log(`[Heartbeat] 生成了新的长期记忆。`);
      await addLongTermMemory(response);
      
      // 记录到今天的日记中
      const time = dayjs().format('HH:mm');
      await writeJournal(`### ${time} [系统反省]\n\n${response}\n`);
      
      // 广播给所有 Agent
      if (systemManager) {
        systemManager.emitEvent('system_message', { message: `[系统反省] ${response}` });
      }
    } else {
      console.log(`[Heartbeat] 无需生成新记忆。`);
    }
  } catch (error) {
    console.error('[Heartbeat] 反省异常:', error.message);
  }
}

/**
 * 启动心跳
 */
export function startHeartbeat(systemManager, intervalMinutes = 60) {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  // 立即执行一次（可选，这里先不立即执行）
  // beat(systemManager);

  heartbeatTimer = setInterval(() => beat(systemManager), intervalMs);
  console.log(`[Heartbeat] 心跳系统已启动，间隔 ${intervalMinutes} 分钟。`);

  return {
    stop: stopHeartbeat
  };
}

/**
 * 停止心跳
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log(`[Heartbeat] 心跳系统已停止。`);
  }
}
