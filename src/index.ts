#!/usr/bin/env node
import 'dotenv/config';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SystemManager } from './system.js';
import { disconnectAll as disconnectMCP } from './mcp.js';
import { MIDOU_WORKSPACE_DIR, MIDOU_PKG } from './config.js';
import { getRecentMemories } from './memory.js';
import {
  getTodoItems,
  addTodoItem,
  updateTodoStatus,
  deleteTodoItem,
} from './todo.js';
import { loadPlugins } from './plugin.js';
import { shutdownRAG } from './rag/index.js';
import type { ChatMessage } from './types.js';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the Vue frontend build
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(MIDOU_PKG, 'web/dist')));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let systemManager: SystemManager | null = null;

async function bootstrap(): Promise<void> {
  if (!fs.existsSync(MIDOU_WORKSPACE_DIR)) {
    fs.mkdirSync(MIDOU_WORKSPACE_DIR, { recursive: true });
  }

  // 首次运行时，从模板目录初始化 workspace
  const templateDir = path.join(MIDOU_PKG, 'workspace');
  if (fs.existsSync(templateDir)) {
    const templateFiles = ['SOUL.md', 'HEARTBEAT.md', 'system.json'];
    for (const file of templateFiles) {
      const dest = path.join(MIDOU_WORKSPACE_DIR, file);
      const src = path.join(templateDir, file);
      if (!fs.existsSync(dest) && fs.existsSync(src)) {
        fs.cpSync(src, dest);
        console.log(`[Init] Created ${file} from template.`);
      }
    }
  }

  systemManager = new SystemManager(io);

  // Load plugins before system initialization so that middlewares are registered
  await loadPlugins(systemManager, app);

  await systemManager.init();

  console.log('Midou backend initialized successfully.');
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on(
    'message',
    async (data: { content: string; targetAgentId?: string }) => {
      if (!systemManager) {
        socket.emit('error', { message: 'System not initialized' });
        return;
      }

      try {
        await systemManager.handleUserMessage(
          data.content,
          data.targetAgentId || null
        );
      } catch (error: unknown) {
        console.error('Chat error:', error);
        socket.emit('error', {
          message: (error as Error).message,
        });
      }
    }
  );

  socket.on(
    'interrupt',
    (data: { targetAgentId?: string }) => {
      if (!systemManager) return;
      try {
        systemManager.interruptAgent(data.targetAgentId || null);
      } catch (error) {
        console.error('Interrupt error:', error);
      }
    }
  );

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// API Routes for Graph Editor
app.get('/api/system', (_req: Request, res: Response) => {
  const systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
  if (fs.existsSync(systemPath)) {
    res.json(JSON.parse(fs.readFileSync(systemPath, 'utf-8')));
  } else {
    res.json({ agents: [], connections: [] });
  }
});

app.post(
  '/api/system',
  async (req: Request, res: Response) => {
    const systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
    fs.writeFileSync(
      systemPath,
      JSON.stringify(req.body, null, 2)
    );

    // Reload system dynamically
    if (systemManager) {
      await systemManager.loadSystem();
    }

    res.json({ success: true });
  }
);

interface HistoryMessage {
  role: string;
  agent: string;
  content: string;
}

app.get(
  '/api/agent/:id/history',
  async (req: Request, res: Response) => {
    if (!systemManager) {
      res.status(500).json({ error: 'System not initialized' });
      return;
    }

    const agentId = req.params.id as string;
    let agent;

    if (
      agentId &&
      agentId !== 'null' &&
      agentId !== 'undefined'
    ) {
      agent = systemManager.agents.get(agentId);
    } else {
      agent = systemManager.agents.values().next().value;
    }

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    let messages: HistoryMessage[] = [];

    try {
      // 1. Get recent memories from logs (last 1 day)
      let recentLogs = await getRecentMemories(1, agent.name);

      // 2. Get current session messages (including tool call details)
      const sessionMessages: HistoryMessage[] = [];
      if (agent.engine && agent.engine.session) {
        const rawMessages: ChatMessage[] = agent.engine.session
          .getMessages()
          .filter(
            (m: ChatMessage) =>
              m.role === 'user' ||
              m.role === 'assistant' ||
              m.role === 'tool'
          );

        for (const m of rawMessages) {
          if (m.role === 'user') {
            if (m.content && m.content.trim()) {
              sessionMessages.push({
                role: 'user',
                agent: 'You',
                content: m.content,
              });
            }
          } else if (m.role === 'assistant') {
            let content = m.content || '';
            if (m.tool_calls && m.tool_calls.length > 0) {
              const toolInfo = m.tool_calls
                .map((tc) => {
                  let argsStr = '';
                  try {
                    const parsed =
                      typeof tc.function.arguments === 'string'
                        ? JSON.parse(tc.function.arguments)
                        : tc.function.arguments;
                    argsStr = Object.entries(parsed as Record<string, unknown>)
                      .map(
                        ([k, v]) =>
                          `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`
                      )
                      .join(', ');
                  } catch {
                    argsStr = tc.function.arguments || '';
                  }
                  return `> 🔧 **${tc.function.name}**(${argsStr})`;
                })
                .join('\n');
              content = content
                ? content + '\n\n' + toolInfo
                : toolInfo;
            }
            if (content.trim()) {
              sessionMessages.push({
                role: 'assistant',
                agent: agent.name,
                content,
              });
            }
          } else if (m.role === 'tool') {
            const truncated =
              (m.content || '').length > 200
                ? m.content!.slice(0, 200) + '...'
                : m.content || '';
            sessionMessages.push({
              role: 'assistant',
              agent: agent.name,
              content: `<details><summary>📎 工具返回结果</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n\n</details>`,
            });
          }
        }
      }

      // 3. Deduplicate
      if (recentLogs && sessionMessages.length > 0) {
        const escapeRegExp = (str: string): string =>
          str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (let i = 0; i < sessionMessages.length; i++) {
          if (sessionMessages[i].role === 'user') {
            const userMsg = sessionMessages[i].content;
            let astMsg = '';
            if (
              i + 1 < sessionMessages.length &&
              sessionMessages[i + 1].role === 'assistant'
            ) {
              astMsg = sessionMessages[i + 1].content;
            }
            if (userMsg && astMsg) {
              const pattern = new RegExp(
                `### \\d{2}:\\d{2}\\n\\n\\*\\*用户\\*\\*: ${escapeRegExp(userMsg)}\\n\\n\\*\\*${escapeRegExp(agent.name)}\\*\\*: ${escapeRegExp(astMsg)}\\n*`,
                'g'
              );
              recentLogs = recentLogs.replace(pattern, '');
            }
          }
        }
        recentLogs = recentLogs.trim();
      }

      if (recentLogs && recentLogs !== '') {
        messages.push({
          role: 'system',
          agent: 'System',
          content: `**[历史日志记录]**\n\n${recentLogs}`,
        });
      }

      messages = [...messages, ...sessionMessages];
    } catch (err) {
      console.error('Failed to load history:', err);
    }

    res.json({ messages });
  }
);

// API Routes for TODOs
app.get(
  '/api/todos',
  async (_req: Request, res: Response) => {
    try {
      const todos = await getTodoItems();
      res.json(todos);
    } catch (err: unknown) {
      res
        .status(500)
        .json({ error: (err as Error).message });
    }
  }
);

app.post(
  '/api/todos',
  async (req: Request, res: Response) => {
    try {
      const { agentId, title, description } = req.body;
      if (!agentId || !title) {
        res
          .status(400)
          .json({ error: 'agentId and title are required' });
        return;
      }
      const newTodo = await addTodoItem(agentId, title, description);
      res.json(newTodo);
    } catch (err: unknown) {
      res
        .status(500)
        .json({ error: (err as Error).message });
    }
  }
);

app.put(
  '/api/todos/:id',
  async (req: Request, res: Response) => {
    try {
      const updated = await updateTodoStatus(
        req.params.id as string,
        req.body
      );
      if (updated) {
        res.json(updated);
      } else {
        res.status(404).json({ error: 'Todo not found' });
      }
    } catch (err: unknown) {
      res
        .status(500)
        .json({ error: (err as Error).message });
    }
  }
);

app.delete(
  '/api/todos/:id',
  async (req: Request, res: Response) => {
    try {
      const success = await deleteTodoItem(req.params.id as string);
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Todo not found' });
      }
    } catch (err: unknown) {
      res
        .status(500)
        .json({ error: (err as Error).message });
    }
  }
);

const PORT = process.env.PORT || 3000;

bootstrap()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Midou backend listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start backend:', err);
    process.exit(1);
  });

// Catch-all route for Vue Router
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(
    path.join(MIDOU_PKG, 'web/dist/index.html')
  );
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (systemManager) {
    systemManager.stopAllCronJobs();
  }
  await disconnectMCP();
  await shutdownRAG();
  process.exit(0);
});
