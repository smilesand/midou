/**
 * Unit Tests for core modules
 * 
 * Tests tool definitions, TODO module, config loading,
 * and other pure logic that doesn't require LLM calls.
 * 
 * Usage: node --test test/test-unit.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// ---- Config ----
describe('Config', () => {
  it('should export MIDOU_PKG and MIDOU_WORKSPACE_DIR', async () => {
    const config = await import('../midou.config.js');
    assert.ok(config.MIDOU_PKG, 'MIDOU_PKG should be set');
    assert.ok(config.MIDOU_WORKSPACE_DIR, 'MIDOU_WORKSPACE_DIR should be set');
    assert.ok(config.default, 'Default config export should exist');
    assert.ok(config.default.llm, 'LLM config should exist');
    assert.ok(config.default.llm.provider, 'LLM provider should be set');
  });

  it('MIDOU_PKG should point to project root', async () => {
    const config = await import('../midou.config.js');
    assert.equal(config.MIDOU_PKG, projectRoot);
  });
});

// ---- Tools ----
describe('Tool Definitions', () => {
  let toolDefinitions;

  before(async () => {
    const toolsModule = await import('../src/tools.js');
    toolDefinitions = toolsModule.toolDefinitions;
  });

  it('should export toolDefinitions array', () => {
    assert.ok(Array.isArray(toolDefinitions), 'toolDefinitions should be an array');
    assert.ok(toolDefinitions.length > 0, 'Should have at least one tool');
  });

  it('should have valid tool schema structure', () => {
    for (const tool of toolDefinitions) {
      assert.equal(tool.type, 'function', `Tool should have type 'function'`);
      assert.ok(tool.function, 'Tool should have function property');
      assert.ok(tool.function.name, 'Tool function should have name');
      assert.ok(tool.function.description, 'Tool function should have description');
      assert.ok(tool.function.parameters, 'Tool function should have parameters');
    }
  });

  it('should include task control tools', () => {
    const names = toolDefinitions.map(t => t.function.name);
    assert.ok(names.includes('finish_task'), 'Should have finish_task');
    assert.ok(names.includes('ask_user'), 'Should have ask_user');
  });

  it('should include all core tools', () => {
    const names = toolDefinitions.map(t => t.function.name);
    
    const expectedTools = [
      'search_memory',
      'add_memory',
      'read_agent_log',
      'send_message',
      'run_command',
      'read_system_file',
      'write_system_file',
      'list_system_dir',
      'list_skills',
      'load_skill',
      'update_todo',
      'list_todos'
    ];

    for (const name of expectedTools) {
      assert.ok(names.includes(name), `Should include tool: ${name}`);
    }
  });

  it('should export registerTool and executeTool functions', async () => {
    const toolsModule = await import('../src/tools.js');
    assert.ok(typeof toolsModule.registerTool === 'function');
    assert.ok(typeof toolsModule.executeTool === 'function');
  });
});

// ---- TODO Module ----
describe('TODO Module', () => {
  let todoModule;
  const testTodoIds = [];

  before(async () => {
    todoModule = await import('../src/todo.js');
  });

  after(async () => {
    // Clean up test todos
    for (const id of testTodoIds) {
      try { await todoModule.deleteTodoItem(id); } catch (e) {}
    }
  });

  it('should get todos (possibly empty)', async () => {
    const todos = await todoModule.getTodoItems();
    assert.ok(Array.isArray(todos));
  });

  it('should add a todo item', async () => {
    const todo = await todoModule.addTodoItem('test-agent', 'Test Task', 'A test description');
    assert.ok(todo.id);
    assert.equal(todo.title, 'Test Task');
    assert.equal(todo.description, 'A test description');
    assert.equal(todo.status, 'pending');
    assert.equal(todo.agentId, 'test-agent');
    testTodoIds.push(todo.id);
  });

  it('should update todo status', async () => {
    const todo = await todoModule.addTodoItem('test-agent', 'Update Test', '');
    testTodoIds.push(todo.id);

    const updated = await todoModule.updateTodoStatus(todo.id, {
      status: 'in_progress',
      notes: 'Working on it'
    });
    assert.ok(updated);
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.notes, 'Working on it');
  });

  it('should filter todos by agentId', async () => {
    await todoModule.addTodoItem('filter-agent', 'Filter Test', '').then(t => testTodoIds.push(t.id));
    
    const filtered = await todoModule.getTodoItems('filter-agent');
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every(t => t.agentId === 'filter-agent'));
  });

  it('should delete a todo item', async () => {
    const todo = await todoModule.addTodoItem('test-agent', 'Delete Me', '');
    
    const deleted = await todoModule.deleteTodoItem(todo.id);
    assert.equal(deleted, true);

    const deletedAgain = await todoModule.deleteTodoItem(todo.id);
    assert.equal(deletedAgain, false, 'Deleting non-existent todo should return false');
  });

  it('should return null when updating non-existent todo', async () => {
    const result = await todoModule.updateTodoStatus('non-existent-id', { status: 'done' });
    assert.equal(result, null);
  });
});

// ---- Agent Class ----
describe('Agent Class', () => {
  it('should handle both data and config keys', async () => {
    const agentModule = await import('../src/agent.js');
    
    // Mock a minimal systemManager
    const mockSystemManager = {
      getOrganizationRoster: () => null,
      buildOutputHandler: null,
      emitEvent: () => {},
    };

    // Test with 'data' key
    const agent1 = new agentModule.Agent({
      id: 'test1',
      name: 'Test1',
      data: { provider: 'openai', model: 'gpt-4o' }
    }, mockSystemManager);
    assert.equal(agent1.config.provider, 'openai');
    assert.equal(agent1.config.model, 'gpt-4o');

    // Test with 'config' key (backward compat)
    const agent2 = new agentModule.Agent({
      id: 'test2',
      name: 'Test2',
      config: { provider: 'anthropic', model: 'claude-sonnet' }
    }, mockSystemManager);
    assert.equal(agent2.config.provider, 'anthropic');
    assert.equal(agent2.config.model, 'claude-sonnet');

    // Test with neither key
    const agent3 = new agentModule.Agent({
      id: 'test3',
      name: 'Test3'
    }, mockSystemManager);
    assert.deepEqual(agent3.config, {});
  });
});

// ---- Plugin System ----
describe('Plugin System', () => {
  it('should export loadPlugins function', async () => {
    const pluginModule = await import('../src/plugin.js');
    assert.ok(typeof pluginModule.loadPlugins === 'function');
  });
});

// ---- Memory Module ----
describe('Memory Module', () => {
  it('should export session memory functions', async () => {
    const memoryModule = await import('../src/memory.js');
    assert.ok(typeof memoryModule.logConversation === 'function');
    assert.ok(typeof memoryModule.getRecentMemories === 'function');
  });
});
