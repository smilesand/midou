#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { SystemManager } from './system.js';
import { disconnectAll as disconnectMCP } from './mcp.js';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';
import { MIDOU_PKG } from '../midou.config.js';
import { getRecentMemories } from './memory.js';
import { getTodoItems, addTodoItem, updateTodoStatus, deleteTodoItem } from './todo.js';
import { loadPlugins } from './plugin.js';
import { shutdownRAG } from './rag/index.js';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the Vue frontend build
const __dirname = path.dirname(new URL(import.meta.url).pathname);
app.use(express.static(path.join(__dirname, '../web/dist')));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let systemManager = null;

async function bootstrap() {
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

  socket.on('message', async (data) => {
    if (!systemManager) {
      socket.emit('error', { message: 'System not initialized' });
      return;
    }
    
    try {
      await systemManager.handleUserMessage(data.content, data.targetAgentId);
    } catch (error) {
      console.error('Chat error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('interrupt', (data) => {
    if (!systemManager) return;
    try {
      systemManager.interruptAgent(data.targetAgentId);
    } catch (error) {
      console.error('Interrupt error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// API Routes for Graph Editor
app.get('/api/system', (req, res) => {
  const systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
  if (fs.existsSync(systemPath)) {
    res.json(JSON.parse(fs.readFileSync(systemPath, 'utf-8')));
  } else {
    res.json({ agents: [], connections: [] });
  }
});

app.post('/api/system', async (req, res) => {
  const systemPath = path.join(MIDOU_WORKSPACE_DIR, 'system.json');
  fs.writeFileSync(systemPath, JSON.stringify(req.body, null, 2));
  
  // Reload system dynamically
  if (systemManager) {
    await systemManager.loadSystem();
  }
  
  res.json({ success: true });
});

app.get('/api/agent/:id/history', async (req, res) => {
  if (!systemManager) {
    return res.status(500).json({ error: 'System not initialized' });
  }
  
  const agentId = req.params.id;
  let agent = null;
  
  if (agentId && agentId !== 'null' && agentId !== 'undefined') {
    agent = systemManager.agents.get(agentId);
  } else {
    agent = systemManager.agents.values().next().value;
  }
  
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  let messages = [];
  
  try {
    // 1. Get recent memories from logs (last 1 day to avoid too much text)
    let recentLogs = await getRecentMemories(1, agent.name);
    
    // 2. Get current session messages (including tool call details)
    let sessionMessages = [];
    if (agent.engine && agent.engine.session) {
      const rawMessages = agent.engine.session.getMessages()
        .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
      
      for (const m of rawMessages) {
        if (m.role === 'user') {
          if (m.content && m.content.trim()) {
            sessionMessages.push({ role: 'user', agent: 'You', content: m.content });
          }
        } else if (m.role === 'assistant') {
          let content = m.content || '';
          // 将工具调用信息附加到 assistant 消息内容中
          if (m.tool_calls && m.tool_calls.length > 0) {
            const toolInfo = m.tool_calls.map(tc => {
              let argsStr = '';
              try {
                const parsed = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
                argsStr = Object.entries(parsed).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
              } catch { argsStr = tc.function.arguments || ''; }
              return `> 🔧 **${tc.function.name}**(${argsStr})`;
            }).join('\n');
            content = content ? content + '\n\n' + toolInfo : toolInfo;
          }
          if (content.trim()) {
            sessionMessages.push({ role: 'assistant', agent: agent.name, content });
          }
        } else if (m.role === 'tool') {
          // 工具返回结果，显示为折叠的详情
          const truncated = (m.content || '').length > 200 ? m.content.slice(0, 200) + '...' : (m.content || '');
          sessionMessages.push({
            role: 'assistant',
            agent: agent.name,
            content: `<details><summary>📎 工具返回结果</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n\n</details>`
          });
        }
      }
    }

    // 3. Deduplicate: remove session messages from recentLogs to avoid showing them twice
    if (recentLogs && sessionMessages.length > 0) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (let i = 0; i < sessionMessages.length; i++) {
        if (sessionMessages[i].role === 'user') {
          const userMsg = sessionMessages[i].content;
          let astMsg = '';
          if (i + 1 < sessionMessages.length && sessionMessages[i+1].role === 'assistant') {
            astMsg = sessionMessages[i+1].content;
          }
          if (userMsg && astMsg) {
            // Match the exact format written by logConversation in memory.js
            const pattern = new RegExp(`### \\d{2}:\\d{2}\\n\\n\\*\\*用户\\*\\*: ${escapeRegExp(userMsg)}\\n\\n\\*\\*${escapeRegExp(agent.name)}\\*\\*: ${escapeRegExp(astMsg)}\\n*`, 'g');
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
        content: `**[历史日志记录]**\n\n${recentLogs}`
      });
    }
    
    messages = [...messages, ...sessionMessages];
  } catch (err) {
    console.error('Failed to load history:', err);
  }
    
  res.json({ messages });
});

// API Routes for TODOs
app.get('/api/todos', async (req, res) => {
  try {
    const todos = await getTodoItems();
    res.json(todos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todos', async (req, res) => {
  try {
    const { agentId, title, description } = req.body;
    if (!agentId || !title) {
      return res.status(400).json({ error: 'agentId and title are required' });
    }
    const newTodo = await addTodoItem(agentId, title, description);
    res.json(newTodo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/todos/:id', async (req, res) => {
  try {
    const updated = await updateTodoStatus(req.params.id, req.body);
    if (updated) {
      res.json(updated);
    } else {
      res.status(404).json({ error: 'Todo not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/todos/:id', async (req, res) => {
  try {
    const success = await deleteTodoItem(req.params.id);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Todo not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

bootstrap().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`Midou backend listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to start backend:', err);
  process.exit(1);
});

// Catch-all route for Vue Router
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../web/dist/index.html'));
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
