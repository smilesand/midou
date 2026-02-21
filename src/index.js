import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { SystemManager } from './system.js';
import { disconnectAll as disconnectMCP } from './mcp.js';
import { MIDOU_COMPANY_DIR } from '../midou.config.js';

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
  if (!fs.existsSync(MIDOU_COMPANY_DIR)) {
    fs.mkdirSync(MIDOU_COMPANY_DIR, { recursive: true });
  }

  systemManager = new SystemManager(io);
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

app.post('/api/system', async (req, res) => {
  const systemPath = path.join(MIDOU_COMPANY_DIR, 'system.json');
  fs.writeFileSync(systemPath, JSON.stringify(req.body, null, 2));
  
  // Reload system dynamically
  if (systemManager) {
    await systemManager.loadSystem();
  }
  
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
  if (systemManager) {
    systemManager.stopAllCronJobs();
  }
  await disconnectMCP();
  process.exit(0);
});
