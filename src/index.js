import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { ChatEngine } from './chat.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { disconnectAll as disconnectMCP } from './mcp.js';
import { loadSoul, buildSystemPrompt } from './soul.js';
import { getRecentMemories } from './memory.js';
import { buildSkillsPrompt } from './skills.js';
import { buildMCPPrompt } from './mcp.js';
import config, { MIDOU_COMPANY_DIR, MIDOU_AGENT_DIR } from '../midou.config.js';
import { isInitialized, initSoulDir, migrateFromWorkspace } from './init.js';

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

// Socket Output Handler for ChatEngine
class SocketOutputHandler {
  constructor(socket) {
    this.socket = socket;
    this.currentMessageId = null;
    this.currentText = '';
  }

  onThinkingStart() {
    this.socket.emit('thinking_start');
  }

  onThinkingDelta(text) {
    this.socket.emit('thinking_delta', { text });
  }

  onThinkingEnd(fullText) {
    this.socket.emit('thinking_end', { fullText });
  }

  onThinkingHidden(length) {
    this.socket.emit('thinking_hidden', { length });
  }

  onTextDelta(text) {
    this.currentText += text;
    this.socket.emit('message_delta', { text: this.currentText });
  }

  onTextPartComplete() {
    // Do nothing
  }

  onTextComplete(truncated = false) {
    this.socket.emit('message_end', { fullText: this.currentText, truncated });
    this.currentText = '';
  }

  onToolStart(name) {
    this.socket.emit('tool_start', { name });
  }

  onToolEnd(name, input) {
    this.socket.emit('tool_end', { name, input });
  }

  onToolExec(name) {
    this.socket.emit('tool_exec', { name });
  }

  onToolResult() {
    this.socket.emit('tool_result');
  }

  onError(message) {
    this.socket.emit('error', { message });
  }

  async confirmCommand(command) {
    // For headless, we can either auto-confirm or reject. Let's auto-confirm for now.
    return true;
  }
}

let engine = null;

async function bootstrap() {
  if (!isInitialized()) {
    console.log('Initializing Midou directory structure...');
    initSoulDir();
    migrateFromWorkspace();
  }

  const soul = loadSoul();
  const memories = getRecentMemories(5);
  const skillsPrompt = buildSkillsPrompt();
  const mcpPrompt = await buildMCPPrompt();
  
  const systemPrompt = buildSystemPrompt(soul, memories, skillsPrompt, mcpPrompt);
  
  engine = new ChatEngine(systemPrompt);
  
  startHeartbeat();
  startScheduler();
  
  console.log('Midou backend initialized successfully.');
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  const outputHandler = new SocketOutputHandler(socket);
  if (engine) {
    engine.setOutputHandler(outputHandler);
  }

  socket.on('message', async (data) => {
    if (!engine) {
      socket.emit('error', { message: 'Engine not initialized' });
      return;
    }
    
    try {
      await engine.talk(data.content);
    } catch (error) {
      console.error('Chat error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// API Routes for Graph Editor
app.get('/api/system', (req, res) => {
  const systemPath = path.join(MIDOU_COMPANY_DIR, 'system.json');
  if (fs.existsSync(systemPath)) {
    res.json(JSON.parse(fs.readFileSync(systemPath, 'utf-8')));
  } else {
    res.json({ agents: [], connections: [] });
  }
});

app.post('/api/system', (req, res) => {
  const systemPath = path.join(MIDOU_COMPANY_DIR, 'system.json');
  fs.writeFileSync(systemPath, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// Catch-all route for Vue Router
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../web/dist/index.html'));
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

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  stopHeartbeat();
  stopScheduler();
  await disconnectMCP();
  process.exit(0);
});
