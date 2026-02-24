/**
 * Unit Tests for core modules
 *
 * Tests tool definitions, TODO module, config loading,
 * memory system, and other pure logic that doesn't require LLM calls.
 *
 * Usage: npx tsx --test test/test-unit.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// ---- Config ----
describe('Config', () => {
  it('should export MIDOU_PKG and MIDOU_WORKSPACE_DIR', async () => {
    const config = await import('../src/config.js');
    assert.ok(config.MIDOU_PKG, 'MIDOU_PKG should be set');
    assert.ok(config.MIDOU_WORKSPACE_DIR, 'MIDOU_WORKSPACE_DIR should be set');
    assert.ok(config.default, 'Default config export should exist');
    assert.ok(config.default.llm, 'LLM config should exist');
    assert.ok(config.default.llm.provider, 'LLM provider should be set');
  });

  it('MIDOU_PKG should point to project root', async () => {
    const config = await import('../src/config.js');
    assert.equal(config.MIDOU_PKG, projectRoot);
  });
});

// ---- Tools ----
describe('Tool System', () => {
  it('should export createCoreTools and registerTool', async () => {
    const toolsModule = await import('../src/tools.js');
    assert.ok(typeof toolsModule.createCoreTools === 'function');
    assert.ok(typeof toolsModule.registerTool === 'function');
    assert.ok(typeof toolsModule.executeTool === 'function');
  });

  it('should create core tool instances', async () => {
    const toolsModule = await import('../src/tools.js');
    const tools = toolsModule.createCoreTools({
      systemManager: null,
      agentId: 'test',
    });
    assert.ok(Array.isArray(tools), 'createCoreTools should return an array');
    assert.ok(tools.length > 0, 'Should have at least one tool');
  });

  it('core tools should include expected tools', async () => {
    const toolsModule = await import('../src/tools.js');
    const tools = toolsModule.createCoreTools({
      systemManager: null,
      agentId: 'test',
    });
    const names = tools.map((t) => t.name);

    const expectedTools = [
      'finish_task',
      'ask_user',
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
      'create_todo',
      'update_todo',
      'list_todos',
    ];

    for (const name of expectedTools) {
      assert.ok(names.includes(name), `Should include tool: ${name}`);
    }
  });

  it('should support dynamic tool registration', async () => {
    const toolsModule = await import('../src/tools.js');
    const initialLen = toolsModule.toolDefinitions.length;

    toolsModule.registerTool(
      {
        type: 'function',
        function: {
          name: 'test_dynamic_tool',
          description: 'A test tool',
          parameters: { type: 'object', properties: {} },
        },
      },
      async () => 'test result'
    );

    assert.equal(toolsModule.toolDefinitions.length, initialLen + 1);
    assert.ok(toolsModule.dynamicToolHandlers.has('test_dynamic_tool'));

    // 通过 executeTool 调用
    const result = await toolsModule.executeTool(
      'test_dynamic_tool',
      {},
      null,
      'test'
    );
    assert.equal(result, 'test result');
  });
});

// ---- TODO Module ----
describe('TODO Module', () => {
  let todoModule: typeof import('../src/todo.js');
  const testTodoIds: string[] = [];

  before(async () => {
    todoModule = await import('../src/todo.js');
  });

  after(async () => {
    for (const id of testTodoIds) {
      try {
        await todoModule.deleteTodoItem(id);
      } catch (_e) {
        // ignore
      }
    }
  });

  it('should get todos (possibly empty)', async () => {
    const todos = await todoModule.getTodoItems();
    assert.ok(Array.isArray(todos));
  });

  it('should add a todo item', async () => {
    const todo = await todoModule.addTodoItem(
      'test-agent',
      'Test Task',
      'A test description'
    );
    assert.ok(todo.id);
    assert.equal(todo.title, 'Test Task');
    assert.equal(todo.description, 'A test description');
    assert.equal(todo.status, 'pending');
    assert.equal(todo.agentId, 'test-agent');
    testTodoIds.push(todo.id);
  });

  it('should update todo status', async () => {
    const todo = await todoModule.addTodoItem(
      'test-agent',
      'Update Test',
      ''
    );
    testTodoIds.push(todo.id);

    const updated = await todoModule.updateTodoStatus(todo.id, {
      status: 'in_progress',
      notes: 'Working on it',
    });
    assert.ok(updated);
    assert.equal(updated!.status, 'in_progress');
    assert.equal(updated!.notes, 'Working on it');
  });

  it('should filter todos by agentId', async () => {
    const t = await todoModule.addTodoItem('filter-agent', 'Filter Test', '');
    testTodoIds.push(t.id);

    const filtered = await todoModule.getTodoItems('filter-agent');
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((t) => t.agentId === 'filter-agent'));
  });

  it('should delete a todo item', async () => {
    const todo = await todoModule.addTodoItem(
      'test-agent',
      'Delete Me',
      ''
    );

    const deleted = await todoModule.deleteTodoItem(todo.id);
    assert.equal(deleted, true);

    const deletedAgain = await todoModule.deleteTodoItem(todo.id);
    assert.equal(
      deletedAgain,
      false,
      'Deleting non-existent todo should return false'
    );
  });

  it('should return null when updating non-existent todo', async () => {
    const result = await todoModule.updateTodoStatus('non-existent-id', {
      status: 'done',
    });
    assert.equal(result, null);
  });
});

// ---- Agent Class ----
describe('Agent Class', () => {
  it('should handle both data and config keys', async () => {
    const agentModule = await import('../src/agent.js');

    const mockSystemManager = {
      getOrganizationRoster: () => null,
      buildOutputHandler: null,
      emitEvent: () => {},
    };

    // Test with 'data' key
    const agent1 = new agentModule.Agent(
      {
        id: 'test1',
        name: 'Test1',
        data: { provider: 'openai', model: 'gpt-4o' },
      },
      mockSystemManager as never
    );
    assert.equal(agent1.config.provider, 'openai');
    assert.equal(agent1.config.model, 'gpt-4o');

    // Test with 'config' key (backward compat)
    const agent2 = new agentModule.Agent(
      {
        id: 'test2',
        name: 'Test2',
        config: { provider: 'anthropic', model: 'claude-sonnet' },
      },
      mockSystemManager as never
    );
    assert.equal(agent2.config.provider, 'anthropic');
    assert.equal(agent2.config.model, 'claude-sonnet');

    // Test with neither key
    const agent3 = new agentModule.Agent(
      {
        id: 'test3',
        name: 'Test3',
      },
      mockSystemManager as never
    );
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

  it('should export MemoryManager and FileMemoryProvider', async () => {
    const memoryModule = await import('../src/memory.js');
    assert.ok(typeof memoryModule.MemoryManager === 'function');
    assert.ok(typeof memoryModule.FileMemoryProvider === 'function');
    assert.ok(memoryModule.memoryManager, 'Should export memoryManager singleton');
  });

  it('should export initMemory function', async () => {
    const memoryModule = await import('../src/memory.js');
    assert.ok(typeof memoryModule.initMemory === 'function');
  });

  it('SessionMemory should manage conversation history', async () => {
    const memoryModule = await import('../src/memory.js');
    const session = new memoryModule.SessionMemory(10);

    session.add('user', 'hello');
    session.add('assistant', 'hi');

    const messages = session.getMessages();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');

    const removed = session.removeLast();
    assert.ok(removed);
    assert.equal(removed!.role, 'assistant');
    assert.equal(session.getMessages().length, 1);

    session.clear();
    assert.equal(session.getMessages().length, 0);
  });
});

// ---- LLM Module ----
describe('LLM Module', () => {
  it('should export NodeLLM wrapper functions', async () => {
    const llmModule = await import('../src/llm.js');
    assert.ok(typeof llmModule.createMidouLLM === 'function');
    assert.ok(typeof llmModule.createChat === 'function');
    assert.ok(typeof llmModule.quickAsk === 'function');
    assert.ok(typeof llmModule.getProvider === 'function');
  });

  it('getProvider should return provider info', async () => {
    const llmModule = await import('../src/llm.js');
    const info = llmModule.getProvider();
    assert.ok(info.name, 'Should have provider name');
    assert.ok(info.model, 'Should have model name');
  });
});
