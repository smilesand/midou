import dayjs from 'dayjs';
import fs from 'fs/promises';
import path from 'path';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import { getRecentMemories, writeJournal } from './memory.js';
import { addMemory } from './rag/index.js';
import { getTodoItems } from './todo.js';
import { LLMClient } from './llm.js';
import type { SystemManagerInterface, LLMConfig } from './types.js';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function isActiveHour(): boolean {
  const hour = dayjs().hour();
  return hour >= 8 && hour < 23;
}

export async function beat(
  systemManager: SystemManagerInterface
): Promise<void> {
  if (!isActiveHour()) {
    return;
  }

  try {
    console.log(`[Heartbeat] 开始全局反省...`);

    if (!systemManager || systemManager.agents.size === 0) {
      console.log(`[Heartbeat] 没有配置任何 Agent，跳过反省。`);
      return;
    }

    for (const [agentId, agent] of systemManager.agents.entries()) {
      console.log(
        `[Heartbeat] 正在反省 Agent: ${agent.name} (${agentId})`
      );

      try {
        const allTodos = await getTodoItems();
        const todos = allTodos.filter(
          (t) => t.agentId === agentId || t.agentId === agent.name
        );
        const pendingTodos = todos.filter(
          (t) => t.status === 'pending' || t.status === 'in_progress'
        );
        if (pendingTodos.length > 0) {
          console.log(
            `[Heartbeat] Agent ${agent.name} 有 ${pendingTodos.length} 个待办任务，触发执行。`
          );
          const todoListStr = pendingTodos
            .map(
              (t) =>
                `- [ID: ${t.id}] ${t.title} (状态: ${t.status})\n  描述: ${t.description || '无'}\n  备注: ${t.notes || '无'}`
            )
            .join('\n');
          const prompt = `系统提示：你有以下待办任务需要处理：\n${todoListStr}\n\n请执行这些任务，并在完成后使用 update_todo 工具更新状态和备注。如果任务需要分步执行，请先更新状态为 in_progress。`;
          agent.talk(prompt);
        }
      } catch (err: unknown) {
        console.error(
          `[Heartbeat] 检查 Agent ${agent.name} 的 TODO 失败:`,
          (err as Error).message
        );
      }

      const recentMemories = await getRecentMemories(1, agent.name);
      if (!recentMemories || recentMemories.trim() === '') {
        console.log(
          `[Heartbeat] Agent ${agent.name} 今日无新记忆，跳过反省。`
        );
        continue;
      }

      let heartbeatStrategy =
        '- 回顾今天的对话，提取重要的事实、用户的偏好或未完成的任务。\n- 总结成简短的长期记忆。';
      try {
        const strategyPath = path.join(
          MIDOU_WORKSPACE_DIR,
          'HEARTBEAT.md'
        );
        const content = await fs.readFile(strategyPath, 'utf-8');
        if (content) heartbeatStrategy = content;
      } catch (_e) {
        // 忽略文件不存在
      }

      const systemPrompt = `你是系统的全局反省引擎。你的任务是阅读最近的对话记录，并根据反省策略提取有价值的信息，转化为长期记忆。保持客观、简洁。`;

      const prompt = `时间: ${dayjs().format('YYYY-MM-DD HH:mm')}
Agent 名称: ${agent.name}
反省策略：
${heartbeatStrategy}

最近的对话记录：
${recentMemories}

请根据策略进行反省。如果没有值得记录的长期记忆，请回复 "NO_REFLECTION_NEEDED"。如果有，请直接输出需要保存的长期记忆内容。`;

      const llmConfig: LLMConfig = {
        provider: agent.config.provider || undefined,
        model: agent.config.model || undefined,
        apiKey: agent.config.apiKey || undefined,
        baseURL: agent.config.baseURL || undefined,
      };

      const llmClient = new LLMClient(llmConfig);
      const response = await llmClient.chatSync([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ]);

      const responseContent = response?.content || '';

      if (
        responseContent &&
        !responseContent.includes('NO_REFLECTION_NEEDED')
      ) {
        console.log(
          `[Heartbeat] Agent ${agent.name} 生成了新的长期记忆。`
        );
        await addMemory(
          agentId,
          `[Agent: ${agent.name}]\n${responseContent}`,
          4,
          'semantic'
        );

        const time = dayjs().format('HH:mm');
        await writeJournal(
          `### ${time} [系统反省]\n\n${responseContent}\n`,
          agent.name
        );

        systemManager.emitEvent('system_message', {
          message: `[系统反省 - ${agent.name}] ${responseContent}`,
        });
      } else {
        console.log(
          `[Heartbeat] Agent ${agent.name} 无需生成新记忆。`
        );
      }
    }
  } catch (error: unknown) {
    console.error(
      '[Heartbeat] 反省异常:',
      (error as Error).message
    );
  }
}

export function startHeartbeat(
  systemManager: SystemManagerInterface,
  intervalMinutes: number = 60
): { stop: () => void } {
  const intervalMs = intervalMinutes * 60 * 1000;

  heartbeatTimer = setInterval(() => beat(systemManager), intervalMs);
  console.log(
    `[Heartbeat] 心跳系统已启动，间隔 ${intervalMinutes} 分钟。`
  );

  return {
    stop: stopHeartbeat,
  };
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log(`[Heartbeat] 心跳系统已停止。`);
  }
}
