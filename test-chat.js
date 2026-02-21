import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('Connected to server');
  
  socket.emit('message', {
    content: 'Hello worker',
    targetAgentId: 'agent-1'
  });
});

socket.on('message_delta', (data) => {
  console.log(`[${data.agentId}] Delta: ${data.text}`);
});

socket.on('message_end', (data) => {
  console.log(`[${data.agentId}] End: ${data.fullText}`);
});

socket.on('error', (data) => {
  console.error(`Error: ${data.message}`);
});

setTimeout(() => {
  socket.disconnect();
  process.exit(0);
}, 10000);
