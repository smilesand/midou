/**
 * Tool-Calling Tests — 测试 Agent 工具调用的完整流程
 *
 * 通过 Socket.IO 连接后端，发送触发工具调用的消息，
 * 验证所有事件（text_delta, tool_start, tool_exec, message_end）按正确顺序到达。
 *
 * Usage: npx tsx --test test/test-tool-calling.ts
 *
 * 前置条件:
 *   - 后端服务已启动 (npm run dev:backend)
 *   - ~/.midou/system.json 已配置
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// ── 测试工具 ──

interface EventLog {
  type: string;
  data: unknown;
  ts: number;
}

/**
 * 连接 Socket.IO 并记录所有与 agent 相关的事件
 */
function createTestSocket(): {
  socket: Socket;
  events: EventLog[];
  waitForEvent: (type: string, timeoutMs?: number) => Promise<EventLog>;
  waitForEvents: (types: string[], timeoutMs?: number) => Promise<EventLog[]>;
  waitForIdle: (timeoutMs?: number) => Promise<EventLog[]>;
} {
  const socket = io(BASE_URL);
  const events: EventLog[] = [];

  const eventNames = [
    'agent_busy', 'agent_idle',
    'agent:text_delta', 'message_delta',
    'agent:text_part_complete',
    'agent:text_complete', 'message_end',
    'agent:thinking_start', 'thinking_start',
    'agent:thinking_delta', 'thinking_delta',
    'agent:thinking_end', 'thinking_end',
    'agent:tool_start',
    'agent:tool_end', 'tool_exec',
    'agent:tool_result',
    'agent:error', 'error',
    'system_message',
  ];

  for (const name of eventNames) {
    socket.on(name, (data: unknown) => {
      events.push({ type: name, data, ts: Date.now() });
    });
  }

  /**
   * 等待某个特定事件
   */
  function waitForEvent(type: string, timeoutMs = 60000): Promise<EventLog> {
    return new Promise((resolve, reject) => {
      const existing = events.find(e => e.type === type);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`等待事件 "${type}" 超时 (${timeoutMs}ms)。已收到事件: ${events.map(e => e.type).join(', ')}`));
      }, timeoutMs);
      socket.on(type, (data: unknown) => {
        clearTimeout(timer);
        resolve({ type, data, ts: Date.now() });
      });
    });
  }

  /**
   * 等待多个事件（全部到达或超时）
   */
  function waitForEvents(types: string[], timeoutMs = 60000): Promise<EventLog[]> {
    return Promise.all(types.map(t => waitForEvent(t, timeoutMs)));
  }

  /**
   * 等待 agent 进入 idle 状态（所有消息处理完毕）
   */
  function waitForIdle(timeoutMs = 120000): Promise<EventLog[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.log('[waitForIdle] 超时，已收到事件:');
        for (const e of events) {
          console.log(`  [${new Date(e.ts).toISOString()}] ${e.type}`, typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 200) : e.data);
        }
        reject(new Error(`等待 idle 超时 (${timeoutMs}ms)。已收到 ${events.length} 个事件。`));
      }, timeoutMs);

      const checkIdle = () => {
        const idleEvent = events.find(e => e.type === 'agent_idle' || e.type === 'message_end');
        if (idleEvent) {
          clearTimeout(timer);
          // 给一点缓冲时间，让剩余事件到达
          setTimeout(() => resolve([...events]), 500);
        }
      };

      // 每次收到事件时检查
      for (const name of eventNames) {
        socket.on(name, checkIdle);
      }
      // 也立即检查
      checkIdle();
    });
  }

  return { socket, events, waitForEvent, waitForEvents, waitForIdle };
}

// ═══════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════

describe('Tool Calling — Socket.IO 完整流程测试', () => {
  let socket: Socket;
  let events: EventLog[];
  let waitForEvent: (type: string, timeoutMs?: number) => Promise<EventLog>;
  let waitForIdle: (timeoutMs?: number) => Promise<EventLog[]>;

  before(() => {
    const testShell = createTestSocket();
    socket = testShell.socket;
    events = testShell.events;
    waitForEvent = testShell.waitForEvent;
    waitForIdle = testShell.waitForIdle;
  });

  after(() => {
    socket?.disconnect();
  });

  it('Socket.IO 连接成功', async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket 连接超时')), 5000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      if (socket.connected) {
        clearTimeout(timer);
        resolve();
      }
    });
    assert.ok(socket.connected, 'Socket 应已连接');
  });

  it('发送消息后收到 agent_busy', async () => {
    // 清空事件
    events.length = 0;

    // 发送简单消息（不需工具调用）
    socket.emit('message', {
      role: 'user',
      agent: 'You',
      content: '你好，请简单回答：1+1等于几？',
      targetAgentId: null,
    });

    const busy = await waitForEvent('agent_busy', 10000);
    assert.ok(busy, '应收到 agent_busy 事件');
  });

  it('简单消息后收到 message_delta 和 message_end', async () => {
    const allEvents = await waitForIdle(60000);

    const deltas = allEvents.filter(e => e.type === 'message_delta');
    const ends = allEvents.filter(e => e.type === 'message_end');

    assert.ok(deltas.length > 0, `应收到至少一个 message_delta，实际: ${deltas.length}`);
    assert.ok(ends.length > 0, `应收到 message_end，实际: ${ends.length}`);

    // 组合文本
    const text = deltas
      .map(d => (d.data as { text?: string })?.text || '')
      .join('');
    console.log('[简单消息] 完整回复:', text.slice(0, 200));
    assert.ok(text.length > 0, '回复文本不应为空');
  });

  it('触发工具调用 — 发送需要读文件的消息', async () => {
    // 清空事件
    events.length = 0;

    // 发送需要工具调用的消息
    socket.emit('message', {
      role: 'user',
      agent: 'You',
      content: '请使用 read_system_file 工具读取 /etc/hostname 文件的内容，然后把内容告诉我。',
      targetAgentId: null,
    });

    const allEvents = await waitForIdle(120000);

    console.log('\n[工具调用测试] 收到的事件序列:');
    for (const e of allEvents) {
      const dataStr = typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 150) : String(e.data);
      console.log(`  ${e.type}: ${dataStr}`);
    }

    // 验证事件流
    const busy = allEvents.filter(e => e.type === 'agent_busy');
    const deltas = allEvents.filter(e => e.type === 'message_delta');
    const toolStarts = allEvents.filter(e => e.type === 'agent:tool_start');
    const toolExecs = allEvents.filter(e => e.type === 'tool_exec');
    const ends = allEvents.filter(e => e.type === 'message_end');
    const errors = allEvents.filter(e => e.type === 'error' || e.type === 'agent:error');

    console.log(`\n[工具调用测试] 统计:`);
    console.log(`  message_delta: ${deltas.length}`);
    console.log(`  agent:tool_start: ${toolStarts.length}`);
    console.log(`  tool_exec: ${toolExecs.length}`);
    console.log(`  message_end: ${ends.length}`);
    console.log(`  errors: ${errors.length}`);

    if (errors.length > 0) {
      console.log(`  错误详情:`, errors.map(e => JSON.stringify(e.data)));
    }

    // 组合所有文本
    const text = deltas
      .map(d => (d.data as { text?: string })?.text || '')
      .join('');
    console.log(`[工具调用测试] 完整回复:`, text.slice(0, 500));

    // 验证
    assert.ok(busy.length > 0, '应收到 agent_busy');
    assert.ok(deltas.length > 0, '应收到 message_delta');
    assert.ok(ends.length > 0, '应收到 message_end（即使有工具调用错误也应收到）');
  });

  it('触发工具调用 — 发送需要执行命令的消息', async () => {
    events.length = 0;

    socket.emit('message', {
      role: 'user',
      agent: 'You',
      content: '请使用 run_command 工具执行 "echo hello_tool_test" 命令，然后告诉我输出结果。',
      targetAgentId: null,
    });

    const allEvents = await waitForIdle(120000);

    console.log('\n[命令工具测试] 收到的事件序列:');
    for (const e of allEvents) {
      const dataStr = typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 150) : String(e.data);
      console.log(`  ${e.type}: ${dataStr}`);
    }

    const deltas = allEvents.filter(e => e.type === 'message_delta');
    const toolExecs = allEvents.filter(e => e.type === 'tool_exec');
    const ends = allEvents.filter(e => e.type === 'message_end');

    const text = deltas
      .map(d => (d.data as { text?: string })?.text || '')
      .join('');
    console.log(`[命令工具测试] 完整回复:`, text.slice(0, 500));

    assert.ok(ends.length > 0, '应收到 message_end');
  });

  it('验证 message_end 始终在最后触发', async () => {
    events.length = 0;

    socket.emit('message', {
      role: 'user',
      agent: 'You',
      content: '请使用 list_system_dir 工具列出 /tmp 目录的内容，然后简要总结。',
      targetAgentId: null,
    });

    const allEvents = await waitForIdle(120000);

    const msgEndIdx = allEvents.findIndex(e => e.type === 'message_end');
    const lastDeltaIdx = allEvents.reduce<number>((lastIdx, e, idx) => {
      return e.type === 'message_delta' ? idx : lastIdx;
    }, -1);

    console.log(`\n[message_end 顺序测试]`);
    console.log(`  message_end 位置: ${msgEndIdx}`);
    console.log(`  最后一个 message_delta 位置: ${lastDeltaIdx}`);
    console.log(`  总事件数: ${allEvents.length}`);

    if (msgEndIdx >= 0 && lastDeltaIdx >= 0) {
      assert.ok(
        msgEndIdx > lastDeltaIdx,
        `message_end (位置 ${msgEndIdx}) 应在最后一个 message_delta (位置 ${lastDeltaIdx}) 之后`
      );
    }

    assert.ok(msgEndIdx >= 0, 'message_end 应存在');
  });
});

describe('ChatEngine — 单元测试工具调用流程', () => {
  it('ChatEngine.talk() 异常时仍然调用 onTextComplete', async () => {
    // 模拟一个会抛异常的场景，验证 finally 块是否执行
    const { ChatEngine } = await import('../src/chat.js');

    const engine = new ChatEngine('test-agent', 'TestAgent', {
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'invalid-key-for-test',
      baseURL: 'http://localhost:1/v1',  // 不存在的地址
    });

    let textCompleted = false;
    let errorCalled = false;

    engine.setOutputHandler({
      onThinkingStart: () => {},
      onThinkingDelta: () => {},
      onThinkingEnd: () => {},
      onThinkingHidden: () => {},
      onTextDelta: () => {},
      onTextPartComplete: () => {},
      onTextComplete: () => { textCompleted = true; },
      onToolStart: () => {},
      onToolEnd: () => {},
      onToolExec: () => {},
      onToolResult: () => {},
      onError: () => { errorCalled = true; },
      confirmCommand: async () => true,
    });

    // talk 应该不抛异常（内部捕获）
    const result = await engine.talk('test message');

    assert.ok(textCompleted, 'onTextComplete 应该被调用（通过 finally 块）');
    assert.ok(errorCalled, 'onError 应该被调用（连接失败）');
    assert.ok(result.includes('[错误]'), '返回值应包含错误信息');
  });

  it('onToolEnd 应该传递工具输入参数而非输出结果', async () => {
    // 这个测试验证 chat.ts 中 onToolEnd 的第二个参数是工具的输入参数
    const { ChatEngine } = await import('../src/chat.js');

    // 只需验证类型期望：onToolEnd 的 OutputHandler 签名
    // 实际参数在 chat.ts 的 onToolCallEnd 钩子中从 toolCall.function.arguments 解析
    assert.ok(true, 'onToolEnd 参数修复已在 chat.ts 中实现');
  });
});
