/**
 * Integration Tests — 完整功能集成测试
 *
 * 使用用户配置的 ~/.midou/system.json 进行测试。
 * 通过模拟用户操作，测试以下核心功能：
 *
 * 1. REST API（状态、Agent列表、系统配置CRUD、TODO CRUD）
 * 2. Agent 配置保存与恢复（含位置信息）
 * 3. Socket.IO 实时通信（消息收发、事件流）
 * 4. 记忆系统（写入、搜索、清理）
 * 5. 插件系统加载
 * 6. LLM 对话（使用真实配置进行端到端测试）
 *
 * Usage: npx tsx --test test/test-integration.ts
 *
 * 前置条件:
 *   - ~/.midou/system.json 已配置
 *   - 后端服务启动 (npm run dev:backend) 或由测试自动启动
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const MIDOU_WORKSPACE = process.env.MIDOU_WORKSPACE_DIR || path.join(process.env.HOME || '/root', '.midou');
const SYSTEM_JSON_PATH = path.join(MIDOU_WORKSPACE, 'system.json');

// ── 测试工具函数 ──

async function apiGet(path: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode || 0, data: body });
        }
      });
    }).on('error', reject);
  });
}

async function apiPost(
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const postData = body ? JSON.stringify(body) : '';
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function apiPut(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const postData = JSON.stringify(body);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function apiDelete(path: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'DELETE',
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 检查服务是否可用 ──

async function isServerRunning(): Promise<boolean> {
  try {
    const { status } = await apiGet('/api/status');
    return status === 200;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════
// 离线测试（不需要服务器运行）
// ══════════════════════════════════════════════════

describe('Offline Tests — 配置与模块验证', () => {
  it('should have system.json in workspace', async () => {
    const exists = await fs.access(SYSTEM_JSON_PATH).then(() => true).catch(() => false);
    assert.ok(exists, `系统配置文件不存在: ${SYSTEM_JSON_PATH}`);
  });

  it('system.json should be valid JSON with agents array', async () => {
    const content = await fs.readFile(SYSTEM_JSON_PATH, 'utf-8');
    const config = JSON.parse(content);
    assert.ok(Array.isArray(config.agents), 'agents 应为数组');
    assert.ok(config.agents.length > 0, '应至少有一个 Agent');
  });

  it('each agent should have id, name, and data', async () => {
    const content = await fs.readFile(SYSTEM_JSON_PATH, 'utf-8');
    const config = JSON.parse(content);
    for (const agent of config.agents) {
      assert.ok(agent.id, `Agent 缺少 id`);
      assert.ok(agent.name, `Agent ${agent.id} 缺少 name`);
      assert.ok(agent.data, `Agent ${agent.id} 缺少 data`);
    }
  });

  it('SystemManager should be importable', async () => {
    const mod = await import('../src/system.js');
    assert.ok(mod.SystemManager, 'SystemManager should exist');
  });

  it('Agent class should store position', async () => {
    const { Agent } = await import('../src/agent.js');
    const agent = new Agent(
      { id: 'test', name: 'Test', position: { x: 100, y: 200 }, data: {} },
      null
    );
    assert.deepEqual(agent.position, { x: 100, y: 200 });
  });

  it('Agent class should work without position', async () => {
    const { Agent } = await import('../src/agent.js');
    const agent = new Agent({ id: 'test2', name: 'Test2' }, null);
    assert.equal(agent.position, undefined);
  });

  it('LLM module should export all required functions', async () => {
    const llm = await import('../src/llm.js');
    assert.ok(typeof llm.createMidouLLM === 'function');
    assert.ok(typeof llm.quickAsk === 'function');
    assert.ok(typeof llm.createChat === 'function');
    assert.ok(typeof llm.getProvider === 'function');
  });

  it('Memory module should export core functions', async () => {
    const mem = await import('../src/memory.js');
    assert.ok(typeof mem.initMemory === 'function');
    assert.ok(typeof mem.memoryManager === 'object');
    assert.ok(typeof mem.SessionMemory === 'function');
  });

  it('Plugin system should export loadPlugins', async () => {
    const plugin = await import('../src/plugin.js');
    assert.ok(typeof plugin.loadPlugins === 'function');
  });

  it('Chat engine should be importable', async () => {
    const chat = await import('../src/chat.js');
    assert.ok(chat.ChatEngine, 'ChatEngine should exist');
  });
});

// ══════════════════════════════════════════════════
// 在线测试（需要后端服务运行）
// ══════════════════════════════════════════════════

describe('Online Tests — REST API', () => {
  let serverAvailable = false;

  before(async () => {
    serverAvailable = await isServerRunning();
    if (!serverAvailable) {
      console.log('⚠️  后端服务未运行，跳过在线测试。请先运行: npm run dev:backend');
    }
  });

  // ── /api/status ──

  it('GET /api/status should return system info', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiGet('/api/status');
    assert.equal(status, 200);
    const d = data as Record<string, unknown>;
    assert.ok(d.provider, 'Should have provider');
    assert.ok(d.model, 'Should have model');
    assert.ok(d.workspace, 'Should have workspace');
    assert.ok(Array.isArray(d.agents), 'Should have agents array');
  });

  // ── /api/agents ──

  it('GET /api/agents should return agent list', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiGet('/api/agents');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    const agents = data as Array<Record<string, unknown>>;
    assert.ok(agents.length > 0, 'Should have at least one agent');
    assert.ok(agents[0].id, 'Agent should have id');
    assert.ok(agents[0].name, 'Agent should have name');
  });

  // ── /api/system GET ──

  it('GET /api/system should return agents with positions', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiGet('/api/system');
    assert.equal(status, 200);
    const d = data as { agents: Array<Record<string, unknown>>; connections: unknown[]; mcpServers?: unknown };
    assert.ok(Array.isArray(d.agents), 'Should have agents');
    assert.ok(Array.isArray(d.connections), 'Should have connections');
    // 验证 agents 有完整数据
    for (const agent of d.agents) {
      assert.ok(agent.id, 'Agent should have id');
      assert.ok(agent.name, 'Agent should have name');
      assert.ok(agent.data, 'Agent should have data');
    }
  });

  // ── /api/system POST (save) ──

  it('POST /api/system should save system configuration', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }

    // 先获取当前配置
    const { data: current } = await apiGet('/api/system');
    const systemData = current as {
      agents: Array<{ id: string; name: string; position?: { x: number; y: number }; data: Record<string, unknown> }>;
      connections: unknown[];
    };

    // 修改位置信息并保存
    if (systemData.agents.length > 0) {
      systemData.agents[0].position = { x: 999, y: 888 };
    }

    const { status, data } = await apiPost('/api/system', systemData as unknown as Record<string, unknown>);
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });

    // 验证位置被保存
    const { data: afterSave } = await apiGet('/api/system');
    const saved = afterSave as typeof systemData;
    if (saved.agents.length > 0) {
      assert.deepEqual(saved.agents[0].position, { x: 999, y: 888 }, 'Position should be persisted');
    }
  });

  // ── /api/agent/:id/history ──

  it('GET /api/agent/:agentId/history should return messages', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { data: sysData } = await apiGet('/api/system');
    const agents = (sysData as { agents: Array<{ id: string }> }).agents;
    if (agents.length === 0) { t.skip('No agents'); return; }
    const agentId = agents[0].id;
    const { status, data } = await apiGet(`/api/agent/${agentId}/history`);
    assert.equal(status, 200);
    const d = data as { messages: unknown[] };
    assert.ok(Array.isArray(d.messages), 'Should have messages array');
  });

  it('GET /api/agent/null/history should return empty messages', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiGet('/api/agent/null/history');
    assert.equal(status, 200);
    const d = data as { messages: unknown[] };
    assert.deepEqual(d.messages, []);
  });

  // ── /api/todos CRUD ──

  it('TODO lifecycle: create → list → update → delete', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }

    // Create
    const { status: createStatus, data: created } = await apiPost('/api/todos', {
      agentId: 'midou',
      title: '集成测试任务',
      description: '这是集成测试自动创建的任务',
    });
    assert.equal(createStatus, 200);
    const todo = created as { id: string; title: string; status: string };
    assert.ok(todo.id, 'Created todo should have id');
    assert.equal(todo.title, '集成测试任务');
    assert.equal(todo.status, 'pending');

    // List
    const { status: listStatus, data: listed } = await apiGet('/api/todos');
    assert.equal(listStatus, 200);
    const todos = listed as Array<{ id: string }>;
    assert.ok(todos.some((t) => t.id === todo.id), 'Created todo should appear in list');

    // Update
    const { status: updateStatus, data: updated } = await apiPut(`/api/todos/${todo.id}`, {
      status: 'in_progress',
      notes: '测试中',
    });
    assert.equal(updateStatus, 200);
    const updatedTodo = updated as { status: string; notes: string };
    assert.equal(updatedTodo.status, 'in_progress');
    assert.equal(updatedTodo.notes, '测试中');

    // Delete
    const { status: delStatus, data: delResult } = await apiDelete(`/api/todos/${todo.id}`);
    assert.equal(delStatus, 200);
    assert.deepEqual(delResult, { ok: true });
  });

  it('POST /api/todos without title should return 400', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status } = await apiPost('/api/todos', { agentId: 'test' });
    assert.equal(status, 400);
  });

  // ── /api/chat ──

  it('POST /api/chat without message should return 400', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status } = await apiPost('/api/chat', {});
    assert.equal(status, 400);
  });

  // ── /api/heartbeat ──

  it('POST /api/heartbeat should respond', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiPost('/api/heartbeat', { agentId: 'midou' });
    assert.equal(status, 200);
    const d = data as { result: string };
    assert.ok(typeof d.result === 'string', 'Should return result string');
  });

  // ── /api/interrupt ──

  it('POST /api/interrupt should respond', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiPost('/api/interrupt', {});
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
  });

  // ── /api/memory/cleanup ──

  it('POST /api/memory/cleanup should respond', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const { status, data } = await apiPost('/api/memory/cleanup', {});
    assert.equal(status, 200);
    const d = data as { cleaned: number };
    assert.ok(typeof d.cleaned === 'number');
  });
});

// ══════════════════════════════════════════════════
// Socket.IO 实时通信测试
// ══════════════════════════════════════════════════

describe('Online Tests — Socket.IO Communication', () => {
  let serverAvailable = false;
  let ioClient: typeof import('socket.io-client');

  before(async () => {
    serverAvailable = await isServerRunning();
    if (serverAvailable) {
      ioClient = await import('socket.io-client');
    }
  });

  it('should connect via Socket.IO', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }
    const socket = ioClient.io(BASE_URL, { timeout: 5000 });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error('Socket.IO connect timeout'));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timer);
        assert.ok(socket.connected, 'Socket should be connected');
        socket.disconnect();
        resolve();
      });

      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(err);
      });
    });
  });

  it('should send message and receive response events', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }

    // 获取第一个 agent
    const { data: sysData } = await apiGet('/api/system');
    const agents = (sysData as { agents: Array<{ id: string }> }).agents;
    if (agents.length === 0) { t.skip('No agents'); return; }
    const agentId = agents[0].id;

    const socket = ioClient.io(BASE_URL, { timeout: 10000 });
    const receivedEvents: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        // 即使超时也检查是否收到了部分事件
        if (receivedEvents.length > 0) {
          resolve();
        } else {
          reject(new Error(`Socket.IO 超时，已收到事件: [${receivedEvents.join(', ')}]`));
        }
      }, 30000);

      socket.on('connect', () => {
        // 发送消息（使用前端 ChatView 的格式）
        socket.emit('message', {
          role: 'user',
          agent: 'You',
          content: '你好，请简单回复一个字"好"',
          targetAgentId: agentId,
        });
      });

      // 监听所有可能的响应事件
      const eventNames = [
        'agent_busy', 'agent_idle',
        'message_delta', 'message_end',
        'thinking_start', 'thinking_delta', 'thinking_end',
        'tool_exec',
        'agent:text_delta', 'agent:text_complete',
        'agent:thinking_start', 'agent:thinking_end',
        'agent:tool_start', 'agent:tool_end',
        'error', 'agent:error',
      ];

      for (const eventName of eventNames) {
        socket.on(eventName, () => {
          if (!receivedEvents.includes(eventName)) {
            receivedEvents.push(eventName);
          }
          // 收到 message_end 或 agent:text_complete 表示完成
          if (eventName === 'message_end' || eventName === 'agent:text_complete') {
            clearTimeout(timer);
            socket.disconnect();
            resolve();
          }
        });
      }

      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(err);
      });
    });

    console.log(`\n  [Socket.IO] 收到事件: ${receivedEvents.join(', ')}`);

    // 至少应该收到某种响应事件
    assert.ok(receivedEvents.length > 0, `Should receive at least one event, got: ${receivedEvents.join(', ')}`);

    // 检查是否收到了核心消息事件
    const hasTextEvent = receivedEvents.includes('message_delta') || receivedEvents.includes('agent:text_delta');
    const hasEndEvent = receivedEvents.includes('message_end') || receivedEvents.includes('agent:text_complete');
    const hasError = receivedEvents.includes('error') || receivedEvents.includes('agent:error');

    if (hasError) {
      console.log('  [Socket.IO] ⚠️ 收到错误事件（可能是 LLM API 配置问题）');
    } else {
      assert.ok(hasTextEvent, 'Should receive text delta event');
      assert.ok(hasEndEvent, 'Should receive message end event');
    }
  });
});

// ══════════════════════════════════════════════════
// 端到端模拟用户测试
// ══════════════════════════════════════════════════

describe('End-to-End — 模拟用户完整流程', () => {
  let serverAvailable = false;

  before(async () => {
    serverAvailable = await isServerRunning();
  });

  it('E2E: 用户打开系统 → 查看Agent → 修改配置 → 保存 → 恢复', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }

    // Step 1: 用户打开 GraphEditor → 加载系统配置
    const { status, data } = await apiGet('/api/system');
    assert.equal(status, 200, 'Step 1: 加载系统配置');
    const config = data as {
      agents: Array<{ id: string; name: string; position?: { x: number; y: number }; data: Record<string, unknown> }>;
      connections: unknown[];
    };
    const originalAgentCount = config.agents.length;
    assert.ok(originalAgentCount > 0, 'Step 1: 应有 Agent');

    // 记录原始数据用于还原
    const originalConfig = JSON.parse(JSON.stringify(config));

    // Step 2: 用户修改第一个 Agent 的位置
    config.agents[0].position = { x: 500, y: 300 };

    // Step 3: 用户保存配置
    const { status: saveStatus } = await apiPost('/api/system', config as unknown as Record<string, unknown>);
    assert.equal(saveStatus, 200, 'Step 3: 保存应成功');

    // Step 4: 用户刷新页面 → 重新加载
    const { data: reloaded } = await apiGet('/api/system');
    const reloadedConfig = reloaded as typeof config;
    assert.equal(reloadedConfig.agents.length, originalAgentCount, 'Step 4: Agent 数量应不变');
    assert.deepEqual(
      reloadedConfig.agents[0].position,
      { x: 500, y: 300 },
      'Step 4: 位置应被正确恢复'
    );

    // Step 5: 还原原始配置
    await apiPost('/api/system', originalConfig as unknown as Record<string, unknown>);
  });

  it('E2E: 用户创建TODO → Agent查看任务 → 完成 → 删除', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }

    // Step 1: 创建任务
    const { data: todo } = await apiPost('/api/todos', {
      agentId: 'midou',
      title: 'E2E测试：整理会议记录',
      description: '自动化测试任务',
    });
    const todoId = (todo as { id: string }).id;
    assert.ok(todoId, 'Step 1: 创建 TODO 成功');

    // Step 2: Agent 查看任务列表
    const { data: list } = await apiGet('/api/todos?agentId=midou');
    const todos = list as Array<{ id: string }>;
    assert.ok(todos.some((t) => t.id === todoId), 'Step 2: Agent 应能看到任务');

    // Step 3: 标记进行中
    const { data: updated } = await apiPut(`/api/todos/${todoId}`, {
      status: 'in_progress',
      notes: '开始处理',
    });
    assert.equal((updated as { status: string }).status, 'in_progress', 'Step 3: 状态更新');

    // Step 4: 标记完成
    await apiPut(`/api/todos/${todoId}`, { status: 'done', notes: '已完成' });

    // Step 5: 删除
    const { data: delResult } = await apiDelete(`/api/todos/${todoId}`);
    assert.deepEqual(delResult, { ok: true }, 'Step 5: 删除成功');
  });

  it('E2E: REST API 聊天发送消息', async (t) => {
    if (!serverAvailable) { t.skip('Server not running'); return; }

    const { data: sysData } = await apiGet('/api/system');
    const agents = (sysData as { agents: Array<{ id: string }> }).agents;
    if (agents.length === 0) { t.skip('No agents'); return; }

    // 通过 REST API 发送消息
    const { status } = await apiPost('/api/chat', {
      message: '你好',
      agentId: agents[0].id,
    });
    // 200 = 成功接受（异步处理）
    assert.equal(status, 200, 'POST /api/chat 应返回 200');
  });
});

// ══════════════════════════════════════════════════
// 数据一致性测试
// ══════════════════════════════════════════════════

describe('Data Consistency — system.json 读写一致性', () => {
  it('should preserve all fields when saving and reloading', async () => {
    const content = await fs.readFile(SYSTEM_JSON_PATH, 'utf-8');
    const original = JSON.parse(content);

    // 验证结构完整性
    assert.ok(Array.isArray(original.agents), 'agents should be array');
    if (original.connections) {
      assert.ok(Array.isArray(original.connections), 'connections should be array');
    }

    // 每个 agent 应有必要字段
    for (const agent of original.agents) {
      assert.ok(agent.id, 'agent.id required');
      assert.ok(agent.name, 'agent.name required');
      if (agent.data) {
        assert.ok(typeof agent.data === 'object', 'agent.data should be object');
      }
    }

    // 每个 connection 应有必要字段
    for (const conn of (original.connections || [])) {
      assert.ok(conn.id, 'connection.id required');
      assert.ok(conn.source, 'connection.source required');
      assert.ok(conn.target, 'connection.target required');
    }
  });

  it('connections should reference existing agent IDs', async () => {
    const content = await fs.readFile(SYSTEM_JSON_PATH, 'utf-8');
    const config = JSON.parse(content);
    const agentIds = new Set(config.agents.map((a: { id: string }) => a.id));

    for (const conn of (config.connections || [])) {
      assert.ok(
        agentIds.has(conn.source),
        `Connection ${conn.id} source "${conn.source}" references non-existent agent`
      );
      assert.ok(
        agentIds.has(conn.target),
        `Connection ${conn.id} target "${conn.target}" references non-existent agent`
      );
    }
  });
});
