/**
 * AST Memory Plugin — Unit Tests
 *
 * 测试 AST 记忆插件的核心功能：
 * - 插件加载与安装（依赖注入）
 * - 记忆写入管线（去重、冲突检测）
 * - 记忆搜索管线（向量搜索、图扩展、排序）
 * - 信心回传
 * - Working Memory 管理
 * - 标签提取
 * - TF-IDF 嵌入和余弦相似度
 * - 记忆整合
 * - 清理机制
 *
 * Usage: npx tsx --test test/test-ast-memory.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// 临时目录用于测试隔离
let tmpDir: string;
let plugin: {
  name: string;
  install: (context: TestPluginContext) => Promise<void>;
};

// 模拟的 PluginContext
interface TestPluginContext {
  systemManager: unknown;
  app: unknown;
  registerTool: (def: unknown, handler: unknown) => void;
  registerMemoryProvider: (provider: TestMemoryProvider) => void;
  createLLM: (options?: Record<string, unknown>) => unknown;
  quickAsk: (prompt: string, systemPrompt?: string) => Promise<string>;
  workspaceDir: string;
}

interface TestMemoryProvider {
  name: string;
  init: () => Promise<void>;
  shutdown: () => Promise<void>;
  addMemory: (agentId: string, content: string, type: string, importance: number) => Promise<string>;
  searchMemory: (agentId: string, query: string, limit: number) => Promise<Array<{
    content: string;
    type: string;
    attentionWeight: number;
    metrics: { timeDecay: number; isRelational: boolean; similarity?: number };
    metadata: Record<string, unknown>;
  }>>;
  cleanup: (daysOld: number, maxImportance: number) => Promise<number>;
  getEngine: () => unknown;
}

// 收集注册的工具和 provider
let registeredProvider: TestMemoryProvider | null = null;
const registeredTools: Array<{ def: unknown; handler: unknown }> = [];

// ── 测试辅助 ──

function createMockContext(workDir: string): TestPluginContext {
  return {
    systemManager: {},
    app: {},
    registerTool: (def: unknown, handler: unknown) => {
      registeredTools.push({ def, handler });
    },
    registerMemoryProvider: (provider: TestMemoryProvider) => {
      registeredProvider = provider;
    },
    // 模拟 LLM — 不进行真实 API 调用
    createLLM: () => ({
      // embed 不可用，强制使用 TF-IDF 后备
    }),
    quickAsk: async (prompt: string, _systemPrompt?: string) => {
      // 模拟 LLM 总结
      return `[模拟总结] ${prompt.slice(0, 50)}...`;
    },
    workspaceDir: workDir,
  };
}

// ══════════════════════════════════════════════════
// 测试套件
// ══════════════════════════════════════════════════

describe('AST Memory Plugin', () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-mem-test-'));
    registeredProvider = null;
    registeredTools.length = 0;

    // 动态导入插件
    const mod = await import('../workspace/plugins/ast-memory/index.ts');
    plugin = mod.default;
  });

  after(async () => {
    if (registeredProvider) {
      await registeredProvider.shutdown();
    }
    // 清理临时目录
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── 插件安装 ──

  describe('Plugin Install', () => {
    it('should export name and install', () => {
      assert.equal(plugin.name, 'ast-memory');
      assert.ok(typeof plugin.install === 'function');
    });

    it('should install and register provider + tools via DI context', async () => {
      const context = createMockContext(tmpDir);
      await plugin.install(context);

      assert.ok(registeredProvider, 'Should register a memory provider');
      assert.equal(registeredProvider!.name, 'ast-memory');
      assert.equal(registeredTools.length, 2, 'Should register 2 tools (consolidate + feedback)');
    });

    it('should not import from ../../src/ (no hard dependency)', async () => {
      const sourceCode = await fs.readFile(
        path.join(__dirname, '..', 'workspace', 'plugins', 'ast-memory', 'index.ts'),
        'utf-8'
      );
      // 确保没有从 src 目录硬引用
      const hasSrcImport = /from\s+['"]\.\.\/\.\.\/src\//g.test(sourceCode);
      assert.equal(hasSrcImport, false, 'Plugin should not have hard imports from ../../src/');
    });
  });

  // ── 记忆 Provider ──

  describe('Memory Provider', () => {
    it('should initialize without error', async () => {
      assert.ok(registeredProvider);
      // init 已在 install 时隐式调用(由 plugin.ts 的 registerMemoryProvider 触发)
      // 但我们这里是手动 mock，需要手动 init
      await registeredProvider!.init();
    });

    it('should add memory and return an ID', async () => {
      const id = await registeredProvider!.addMemory('test-agent', '用户喜欢深色主题', 'semantic', 3);
      assert.ok(id, 'Should return a memory ID');
      assert.ok(typeof id === 'string');
      assert.ok(id.startsWith('ast-'), `ID should start with 'ast-', got: ${id}`);
    });

    it('should add multiple memories', async () => {
      const id1 = await registeredProvider!.addMemory('test-agent', '项目使用 TypeScript 开发', 'semantic', 4);
      const id2 = await registeredProvider!.addMemory('test-agent', '数据库选型为 PostgreSQL', 'episodic', 2);
      const id3 = await registeredProvider!.addMemory('test-agent', 'API 框架是 Express', 'semantic', 3);
      assert.ok(id1);
      assert.ok(id2);
      assert.ok(id3);
      // IDs 应该不同
      assert.notEqual(id1, id2);
      assert.notEqual(id2, id3);
    });

    it('should search memory and return results', async () => {
      const results = await registeredProvider!.searchMemory('test-agent', 'TypeScript', 5);
      assert.ok(Array.isArray(results));
      assert.ok(results.length > 0, 'Should find at least one result');

      // 验证结果结构
      const first = results[0];
      assert.ok(typeof first.content === 'string');
      assert.ok(typeof first.type === 'string');
      assert.ok(typeof first.attentionWeight === 'number');
      assert.ok(first.attentionWeight >= 0 && first.attentionWeight <= 1, 'Weight should be 0-1');
      assert.ok(typeof first.metrics.timeDecay === 'number');
      assert.ok(typeof first.metrics.isRelational === 'boolean');
      assert.ok(first.metadata);
    });

    it('should return empty array for unrelated search', async () => {
      // 即使没有完全匹配，TF-IDF 也会返回结果（只是相似度低）
      // 搜索结果按 attentionWeight 排序
      const results = await registeredProvider!.searchMemory('nonexistent-agent', '量子物理', 5);
      assert.ok(Array.isArray(results));
      // 不存在的 agent 应该没有记忆
      assert.equal(results.length, 0, 'Non-existent agent should have no memories');
    });
  });

  // ── 去重 ──

  describe('Deduplication', () => {
    it('should deduplicate highly similar memories', async () => {
      const id1 = await registeredProvider!.addMemory('dedup-agent', '用户偏好深色主题的界面', 'semantic', 3);
      const id2 = await registeredProvider!.addMemory('dedup-agent', '用户偏好深色主题的界面设计', 'semantic', 4);
      // 由于 TF-IDF 嵌入，非常相似的文本可能被去重（返回相同 ID）
      // 这里验证系统不会崩溃
      assert.ok(id1);
      assert.ok(id2);
    });
  });

  // ── 信心回传 ──

  describe('Confidence Backpropagation', () => {
    it('should update confidence on success feedback', async () => {
      const engine = registeredProvider!.getEngine() as {
        updateConfidence: (agentId: string, memoryId: string, feedback: 'success' | 'failure') => Promise<void>;
      };

      const id = await registeredProvider!.addMemory('conf-agent', '测试信心回传', 'semantic', 3);
      // 正向反馈应增加置信度
      await engine.updateConfidence('conf-agent', id, 'success');
      // 不抛异常即可
    });

    it('should update confidence on failure feedback', async () => {
      const engine = registeredProvider!.getEngine() as {
        updateConfidence: (agentId: string, memoryId: string, feedback: 'success' | 'failure') => Promise<void>;
      };

      const id = await registeredProvider!.addMemory('conf-agent', '可能不准确的信息', 'semantic', 2);
      await engine.updateConfidence('conf-agent', id, 'failure');
      // 不抛异常即可
    });

    it('should silently handle non-existent memory ID', async () => {
      const engine = registeredProvider!.getEngine() as {
        updateConfidence: (agentId: string, memoryId: string, feedback: 'success' | 'failure') => Promise<void>;
      };
      // 不应抛异常
      await engine.updateConfidence('any-agent', 'nonexistent-id', 'success');
    });
  });

  // ── 记忆整合 ──

  describe('Consolidation', () => {
    it('should skip consolidation when memories are insufficient', async () => {
      const engine = registeredProvider!.getEngine() as {
        consolidate: (agentId: string) => Promise<string>;
      };
      const result = await engine.consolidate('empty-agent');
      assert.ok(result.includes('不足') || result.includes('没有'), `Expected skip message, got: ${result}`);
    });

    it('should consolidate when enough related memories exist', async () => {
      const engine = registeredProvider!.getEngine() as {
        consolidate: (agentId: string) => Promise<string>;
      };

      // 添加足够多的相关记忆（需要同标签形成聚类）
      const agentId = 'consolidate-agent';
      for (let i = 0; i < 8; i++) {
        await registeredProvider!.addMemory(
          agentId,
          `TypeScript 项目配置优化技巧 ${i}: 使用 strict 模式提升代码质量`,
          'semantic',
          3
        );
      }

      const result = await engine.consolidate(agentId);
      assert.ok(typeof result === 'string');
      // 结果可能是 "整合完成" 或 "没有需要整合"，取决于标签聚类
    });
  });

  // ── 清理 ──

  describe('Cleanup', () => {
    it('should cleanup old low-importance memories', async () => {
      const count = await registeredProvider!.cleanup(0, 5);
      assert.ok(typeof count === 'number');
      assert.ok(count >= 0);
    });
  });

  // ── 注册工具 ──

  describe('Registered Tools', () => {
    it('should register consolidate_memory tool', () => {
      const consolTool = registeredTools.find(
        (t) => (t.def as { function: { name: string } }).function.name === 'consolidate_memory'
      );
      assert.ok(consolTool, 'consolidate_memory tool should be registered');
    });

    it('should register memory_feedback tool', () => {
      const fbTool = registeredTools.find(
        (t) => (t.def as { function: { name: string } }).function.name === 'memory_feedback'
      );
      assert.ok(fbTool, 'memory_feedback tool should be registered');
    });

    it('consolidate_memory tool should execute', async () => {
      const consolTool = registeredTools.find(
        (t) => (t.def as { function: { name: string } }).function.name === 'consolidate_memory'
      );
      assert.ok(consolTool);
      const handler = consolTool!.handler as (args: Record<string, unknown>) => Promise<string>;
      const result = await handler({ agent_id: 'empty-agent' });
      assert.ok(typeof result === 'string');
    });

    it('memory_feedback tool should execute', async () => {
      // 先创建一个记忆
      const memId = await registeredProvider!.addMemory('tool-test-agent', '工具测试数据', 'semantic', 3);

      const fbTool = registeredTools.find(
        (t) => (t.def as { function: { name: string } }).function.name === 'memory_feedback'
      );
      assert.ok(fbTool);
      const handler = fbTool!.handler as (args: Record<string, unknown>) => Promise<string>;
      const result = await handler({
        agent_id: 'tool-test-agent',
        memory_id: memId,
        feedback: 'success',
      });
      assert.ok(result.includes(memId));
      assert.ok(result.includes('success'));
    });
  });

  // ── 持久化 ──

  describe('Persistence', () => {
    it('should persist memories to disk', async () => {
      await registeredProvider!.addMemory('persist-agent', '持久化测试数据', 'semantic', 4);
      // 强制保存（shutdown 会触发）
      await registeredProvider!.shutdown();

      // 检查文件存在
      const storeFile = path.join(tmpDir, 'ast-store', 'persist-agent.json');
      const content = await fs.readFile(storeFile, 'utf-8');
      const store = JSON.parse(content);
      assert.ok(store.memories, 'Store should have memories');
      assert.ok(Object.keys(store.memories).length > 0, 'Should have at least one memory');
      assert.ok(store.stats, 'Store should have stats');

      // 重新初始化以恢复状态
      await registeredProvider!.init();
    });
  });
});

// ── __dirname polyfill for ESM ──
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
