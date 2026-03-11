/**
 * midou — 多智能体 AI 系统入口
 *
 * Express + Socket.IO 服务器，提供 REST API 和实时通信。
 */

import express from 'express';
import { createServer } from 'http';
import net from 'net';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { SystemManager } from './system.js';
import { heartbeat, memoryCleanup } from './heartbeat.js';
import { getTodoItems, addTodoItem, updateTodoStatus, deleteTodoItem } from './todo.js';
import config, { MIDOU_PKG, MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  OutputHandler,
  AgentInterface,
  AgentConfig,
} from './types.js';

// 加载环境变量
dotenv.config();

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── 全局系统管理器 ──

let systemManager: SystemManager;

// ═══════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════

// 系统信息
app.get('/api/status', (_req, res) => {
  const agents: Array<{ id: string; name: string; busy: boolean }> = [];
  if (systemManager) {
    for (const [id, agent] of systemManager.agents) {
      agents.push({ id, name: agent.name, busy: agent.isBusy });
    }
  }
  res.json({
    version: MIDOU_PKG,
    provider: config.llm.provider,
    model: config.llm.model,
    agents,
    workspace: MIDOU_WORKSPACE_DIR,
  });
});

// Agent 列表
app.get('/api/agents', (_req, res) => {
  const list: Array<Record<string, unknown>> = [];
  if (systemManager) {
    for (const [, agent] of systemManager.agents) {
      list.push({
        id: agent.id,
        name: agent.name,
        config: agent.config,
        busy: agent.isBusy,
      });
    }
  }
  res.json(list);
});

// 发送消息
app.post('/api/chat', async (req, res) => {
  const { message, agentId } = req.body as { message?: string; agentId?: string };
  if (!message) {
    res.status(400).json({ error: '缺少 message 参数' });
    return;
  }
  try {
    await systemManager.handleUserMessage(message, agentId);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// 中断
app.post('/api/interrupt', (req, res) => {
  const { agentId } = req.body as { agentId?: string };
  systemManager.interruptAgent(agentId);
  res.json({ ok: true });
});

// Heartbeat
app.post('/api/heartbeat', async (req, res) => {
  const { agentId } = req.body as { agentId?: string };
  const result = await heartbeat(agentId || 'midou');
  res.json({ result });
});

// TODO API
app.get('/api/todos', async (req, res) => {
  const agentId = (req.query.agentId as string) || null;
  const items = await getTodoItems(agentId);
  res.json(items);
});

app.post('/api/todos', async (req, res) => {
  const { agentId, title, description } = req.body as {
    agentId?: string; title?: string; description?: string;
  };
  if (!title) {
    res.status(400).json({ error: '缺少 title' });
    return;
  }
  const item = await addTodoItem(agentId || 'midou', title, description);
  res.json(item);
});

app.put('/api/todos/:id', async (req, res) => {
  const item = await updateTodoStatus(req.params.id, req.body);
  if (!item) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }
  res.json(item);
});

app.delete('/api/todos/:id', async (req, res) => {
  const ok = await deleteTodoItem(req.params.id);
  res.json({ ok });
});

// 系统配置
app.get('/api/system', async (_req, res) => {
  const agents: AgentConfig[] = [];
  for (const [, agent] of systemManager.agents) {
    agents.push({
      id: agent.id,
      name: agent.name,
      position: agent.position,
      data: agent.config,
    });
  }
  res.json({
    agents,
    connections: systemManager.connections,
    mcpServers: (systemManager as any)._mcpServers || {},
  });
});

app.post('/api/system', async (req, res) => {
  try {
    const data = req.body as {
      agents?: Array<{ id: string; name: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>;
      connections?: Array<Record<string, unknown>>;
      mcpServers?: Record<string, unknown>;
    };
    if (data && (data.agents || data.connections)) {
      // 前端发送了完整配置，更新并保存
      await systemManager.updateFromFrontend(data as any);
    } else {
      // 克来的：只是储存当前状态
      await systemManager.saveSystem();
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Agent 对话历史
app.get('/api/agent/:agentId/history', async (req, res) => {
  const { agentId } = req.params;
  if (!systemManager || agentId === 'null') {
    res.json({ messages: [] });
    return;
  }
  const agent = systemManager.agents.get(agentId);
  if (!agent || !agent.engine) {
    res.json({ messages: [] });
    return;
  }
  const sessionMsgs = agent.engine.session.getMessages();
  const messages = sessionMsgs.map((m) => ({
    role: m.role,
    agent: m.role === 'user' ? 'You' : agent.name,
    content: m.content,
  }));
  res.json({ messages });
});

// 记忆清理
app.post('/api/memory/cleanup', async (_req, res) => {
  const cleaned = await memoryCleanup();
  res.json({ cleaned });
});

// ═══════════════════════════════════════════
// Socket.IO 实时通信
// ═══════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('[WS] 客户端已连接:', socket.id);

  // 支持前端两种事件格式：'message' (ChatView) 和 'chat:send' (兼容)
  const handleMessage = async (data: { message?: string; content?: string; agentId?: string; targetAgentId?: string }) => {
    const message = data.message || data.content || '';
    const agentId = data.agentId || data.targetAgentId;
    const targetId = agentId || 'midou';
    const agent = systemManager.agents.get(targetId);
    if (!agent) {
      socket.emit('agent:error', { error: `Agent ${targetId} 不存在` });
      socket.emit('error', { agentId: targetId, message: `Agent ${targetId} 不存在` });
      return;
    }

    // 设置 busy 状态
    socket.emit('agent_busy', { agentId: targetId });

    // 构建 Socket 输出处理器（发送两套事件名：前端兼容 + agent: 前缀）
    const baseHandler: OutputHandler = {
      onThinkingStart: () => {
        socket.emit('agent:thinking_start', { agentId: targetId });
        socket.emit('thinking_start', { agentId: targetId });
      },
      onThinkingDelta: (text) => {
        socket.emit('agent:thinking_delta', { agentId: targetId, text });
        socket.emit('thinking_delta', { agentId: targetId, text });
      },
      onThinkingEnd: (fullText) => {
        socket.emit('agent:thinking_end', { agentId: targetId, fullText });
        socket.emit('thinking_end', { agentId: targetId });
      },
      onThinkingHidden: (length) => {
        socket.emit('agent:thinking_hidden', { agentId: targetId, length });
      },
      onTextDelta: (text) => {
        socket.emit('agent:text_delta', { agentId: targetId, text });
        socket.emit('message_delta', { agentId: targetId, text });
      },
      onTextPartComplete: () => {
        socket.emit('agent:text_part_complete', { agentId: targetId });
      },
      onTextComplete: (truncated) => {
        socket.emit('agent:text_complete', { agentId: targetId, truncated });
        socket.emit('message_end', { agentId: targetId });
        socket.emit('agent_idle', { agentId: targetId });
      },
      onToolStart: (name) => {
        socket.emit('agent:tool_start', { agentId: targetId, name });
      },
      onToolEnd: (name, input) => {
        socket.emit('agent:tool_end', { agentId: targetId, name, input });
        socket.emit('tool_exec', { agentId: targetId, name, args: input });
      },
      onToolExec: (name, args) => {
        socket.emit('agent:tool_exec', { agentId: targetId, name, args });
      },
      onToolResult: () => {
        socket.emit('agent:tool_result', { agentId: targetId });
      },
      onError: (msg) => {
        socket.emit('agent:error', { agentId: targetId, error: msg });
        socket.emit('error', { agentId: targetId, message: msg });
      },
      confirmCommand: async (command) => {
        return new Promise((resolve) => {
          socket.emit('agent:confirm_command', { agentId: targetId, command });
          socket.once('agent:confirm_response', (resp: { confirmed: boolean }) => {
            resolve(resp.confirmed);
          });
          // 30 秒超时自动拒绝
          setTimeout(() => resolve(false), 30000);
        });
      },
    };

    // 应用中间件
    const handler = systemManager.buildOutputHandler(agent, baseHandler);
    agent.setOutputHandler(handler);

    try {
      await agent.talk(message);
    } catch (err: unknown) {
      socket.emit('agent:error', { agentId: targetId, error: (err as Error).message });
      socket.emit('error', { agentId: targetId, message: (err as Error).message });
    }
  };

  // 监听前端事件 (ChatView 发送 'message'，兼容 'chat:send')
  socket.on('message', handleMessage);
  socket.on('chat:send', handleMessage);

  const handleInterrupt = (data: { agentId?: string; targetAgentId?: string }) => {
    systemManager.interruptAgent(data.agentId || data.targetAgentId);
  };
  socket.on('interrupt', handleInterrupt);
  socket.on('chat:interrupt', handleInterrupt);

  socket.on('disconnect', () => {
    console.log('[WS] 客户端断开:', socket.id);
  });
});

// ═══════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();

    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(err);
    });

    tester.once('listening', () => {
      tester.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(true);
      });
    });

    tester.listen(port);
  });
}

async function listenServer(port: number): Promise<void> {
  return await new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

async function main(): Promise<void> {
  const port = parseInt(process.env.MIDOU_PORT || '3000', 10);

  if (!(await isPortAvailable(port))) {
    console.error(`\n[Startup] 端口 ${port} 已被占用，后端未重复启动。`);
    console.error('[Startup] 如果这是你之前启动的 midou 实例，可直接继续使用前端。');
    console.error('[Startup] 如果不是，请先停止占用该端口的进程，或设置 MIDOU_PORT 后重试。\n');
    return;
  }

  console.log(`\n🎀 midou ${MIDOU_PKG}`);
  console.log(`   Provider: ${config.llm.provider}`);
  console.log(`   Model: ${config.llm.model}`);
  console.log(`   Workspace: ${MIDOU_WORKSPACE_DIR}\n`);

  systemManager = new SystemManager(io, app);
  await systemManager.loadSystem();

  try {
    await listenServer(port);
    console.log(`\n🌐 midou 服务已启动: http://localhost:${port}\n`);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EADDRINUSE') {
      console.error(`\n[Startup] 端口 ${port} 已被占用，后端未重复启动。`);
      console.error('[Startup] 如果这是你之前启动的 midou 实例，可直接继续使用前端。');
      console.error('[Startup] 如果不是，请先停止占用该端口的进程，或设置 MIDOU_PORT 后重试。\n');
      return;
    }
    throw err;
  }
}

// 优雅关机
process.on('SIGINT', async () => {
  console.log('\n正在关闭...');
  if (systemManager) await systemManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (systemManager) await systemManager.shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

export { app, io, systemManager };
