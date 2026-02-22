/**
 * API & Server Tests
 * 
 * Tests the Express server endpoints and Socket.IO setup.
 * Starts the full backend and tests against it.
 * 
 * Usage: node --test test/test-api.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:3000';

// Import and start the server
let serverProcess;

async function waitForServer(maxWait = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`${BASE_URL}/api/system`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) return true;
    } catch (e) {
      // Still starting
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Server failed to start within timeout');
}

describe('API Endpoints', () => {
  before(async () => {
    // Start the server as a child process
    const { spawn } = await import('child_process');
    const { fileURLToPath } = await import('url');
    const path = await import('path');
    
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.join(__dirname, '..');
    
    serverProcess = spawn('node', ['src/index.js'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    serverProcess.stderr.on('data', (d) => {
      const msg = d.toString();
      // Only log real errors, not deprecation warnings
      if (!msg.includes('DeprecationWarning') && !msg.includes('punycode')) {
        process.stderr.write(msg);
      }
    });

    await waitForServer();
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => {
        serverProcess.on('exit', resolve);
        setTimeout(() => {
          serverProcess.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }
    // Give ChromaDB time to shut down
    await new Promise(r => setTimeout(r, 2000));
  });

  // ---- GET /api/system ----
  it('GET /api/system should return system config', async () => {
    const resp = await fetch(`${BASE_URL}/api/system`);
    assert.equal(resp.status, 200);
    
    const data = await resp.json();
    assert.ok(Array.isArray(data.agents), 'Should have agents array');
    assert.ok(Array.isArray(data.connections), 'Should have connections array');
  });

  it('GET /api/system should include agent data', async () => {
    const resp = await fetch(`${BASE_URL}/api/system`);
    const data = await resp.json();
    
    if (data.agents.length > 0) {
      const agent = data.agents[0];
      assert.ok(agent.id, 'Agent should have id');
      assert.ok(agent.name, 'Agent should have name');
    }
  });

  // ---- GET /api/todos ----
  it('GET /api/todos should return array', async () => {
    const resp = await fetch(`${BASE_URL}/api/todos`);
    assert.equal(resp.status, 200);
    
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'Should return an array');
  });

  // ---- POST /api/todos ----
  it('POST /api/todos should create a todo', async () => {
    const resp = await fetch(`${BASE_URL}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        title: 'Test todo item',
        description: 'Created by test'
      })
    });
    assert.equal(resp.status, 200);
    
    const todo = await resp.json();
    assert.ok(todo.id, 'Todo should have id');
    assert.equal(todo.title, 'Test todo item');
    assert.equal(todo.status, 'pending');
    
    // Clean up
    await fetch(`${BASE_URL}/api/todos/${todo.id}`, { method: 'DELETE' });
  });

  it('POST /api/todos should validate required fields', async () => {
    const resp = await fetch(`${BASE_URL}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Missing agentId' })
    });
    assert.equal(resp.status, 400);
  });

  // ---- PUT /api/todos/:id ----
  it('PUT /api/todos/:id should update a todo', async () => {
    // Create
    const createResp = await fetch(`${BASE_URL}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'test', title: 'Update me' })
    });
    const created = await createResp.json();

    // Update
    const updateResp = await fetch(`${BASE_URL}/api/todos/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', notes: 'Done!' })
    });
    assert.equal(updateResp.status, 200);
    
    const updated = await updateResp.json();
    assert.equal(updated.status, 'completed');
    assert.equal(updated.notes, 'Done!');

    // Clean up
    await fetch(`${BASE_URL}/api/todos/${created.id}`, { method: 'DELETE' });
  });

  // ---- DELETE /api/todos/:id ----
  it('DELETE /api/todos/:id should remove a todo', async () => {
    // Create
    const createResp = await fetch(`${BASE_URL}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'test', title: 'Delete me' })
    });
    const created = await createResp.json();

    // Delete
    const deleteResp = await fetch(`${BASE_URL}/api/todos/${created.id}`, {
      method: 'DELETE'
    });
    assert.equal(deleteResp.status, 200);
    
    const result = await deleteResp.json();
    assert.equal(result.success, true);
  });

  // ---- GET /api/agent/:id/history ----
  it('GET /api/agent/:id/history should return messages', async () => {
    // Use the first agent from system config
    const sysResp = await fetch(`${BASE_URL}/api/system`);
    const sys = await sysResp.json();
    
    if (sys.agents.length > 0) {
      const agentId = sys.agents[0].id;
      const resp = await fetch(`${BASE_URL}/api/agent/${agentId}/history`);
      assert.equal(resp.status, 200);
      
      const data = await resp.json();
      assert.ok(Array.isArray(data.messages), 'Should have messages array');
    }
  });

  it('GET /api/agent/nonexistent/history should return 404', async () => {
    const resp = await fetch(`${BASE_URL}/api/agent/nonexistent-agent-xyz/history`);
    assert.equal(resp.status, 404);
  });
});
