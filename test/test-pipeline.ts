/**
 * 流水线系统功能测试
 *
 * 测试制品系统、契约解析器、流水线引擎、角色工具过滤。
 * 运行: npx tsx test/test-pipeline.ts
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import assert from 'assert';

// ── Artifact 测试 ──

import {
  createArtifact,
  getArtifact,
  listStageArtifacts,
  collectArtifactsByType,
  listRunArtifacts,
} from '../src/artifact.js';

// ── Contract 测试 ──

import { parseContractsFromSource, parseContractsFromDir } from '../src/contract.js';

// ── Tools 测试（角色过滤） ──

import { createCoreTools, getAllToolDefinitions } from '../src/tools.js';
import type { AgentRole } from '../src/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e: unknown) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${(e as Error).message}`);
    }
  })();
}

// ═══════════════════════════════════════════
// 1. Artifact Store 测试
// ═══════════════════════════════════════════

async function testArtifactStore() {
  console.log('\n=== Artifact Store ===');

  const runId = `test-run-${Date.now()}`;

  await test('createArtifact 创建制品并返回完整数据', async () => {
    const art = await createArtifact('contract', 'agent-1', runId, 'stage-design', {
      module: 'user',
      endpoint: 'getUser',
    });
    assert.ok(art.id.startsWith('art-'));
    assert.strictEqual(art.type, 'contract');
    assert.strictEqual(art.producedBy, 'agent-1');
    assert.strictEqual(art.pipelineRunId, runId);
    assert.strictEqual(art.stageId, 'stage-design');
    assert.ok(art.createdAt);
  });

  await test('getArtifact 可以读取已创建的制品', async () => {
    const art = await createArtifact('code', 'agent-2', runId, 'stage-impl', { code: 'console.log("hi")' });
    const read = await getArtifact(runId, 'stage-impl', art.id);
    assert.ok(read);
    assert.strictEqual(read!.id, art.id);
    assert.strictEqual(read!.type, 'code');
    assert.deepStrictEqual(read!.payload, { code: 'console.log("hi")' });
  });

  await test('getArtifact 不存在时返回 null', async () => {
    const read = await getArtifact(runId, 'stage-impl', 'nonexistent');
    assert.strictEqual(read, null);
  });

  await test('listStageArtifacts 列出某阶段所有制品', async () => {
    await createArtifact('code', 'agent-2', runId, 'stage-list', { file: 'a.ts' });
    await createArtifact('code', 'agent-2', runId, 'stage-list', { file: 'b.ts' });
    const list = await listStageArtifacts(runId, 'stage-list');
    assert.ok(list.length >= 2);
  });

  await test('collectArtifactsByType 按类型筛选', async () => {
    await createArtifact('test-suite', 'agent-3', runId, 'stage-test', { tests: ['t1'] });
    await createArtifact('code', 'agent-3', runId, 'stage-test', { code: 'x' });
    const filtered = await collectArtifactsByType(runId, ['stage-test'], ['test-suite']);
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every(a => a.type === 'test-suite'));
  });

  await test('listRunArtifacts 列出整个 run 的所有制品', async () => {
    const all = await listRunArtifacts(runId);
    assert.ok(all.length >= 4); // 之前创建了至少 4 个
  });

  // 清理
  const artifactsDir = path.join(process.env.MIDOU_WORKSPACE || path.join(os.homedir(), '.midou'), 'artifacts', runId);
  await fs.rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
}

// ═══════════════════════════════════════════
// 2. Contract Parser 测试
// ═══════════════════════════════════════════

async function testContractParser() {
  console.log('\n=== Contract Parser ===');

  await test('parseContractsFromSource 解析基本契约', () => {
    const source = `
/**
 * @api-contract
 * @module user
 * @endpoint getUser
 * @method GET
 * @path /api/users/:id
 * @summary 获取用户信息
 * @description 根据用户 ID 获取详细的用户信息
 * @permission user:read
 * @requestBody
 * - id {string} [required] 用户 ID
 * @response 200 成功返回用户信息
 * - name {string} [required] 用户名
 * - email {string} [required] 邮箱
 * @response 404 用户不存在
 */
export function getUser() {}
`;
    const contracts = parseContractsFromSource(source);
    assert.strictEqual(contracts.length, 1);
    const c = contracts[0];
    assert.strictEqual(c.module, 'user');
    assert.strictEqual(c.endpoint, 'getUser');
    assert.strictEqual(c.method, 'GET');
    assert.strictEqual(c.path, '/api/users/:id');
    assert.strictEqual(c.summary, '获取用户信息');
    assert.strictEqual(c.permission, 'user:read');
    assert.ok(c.requestBody);
    assert.strictEqual(c.requestBody!.length, 1);
    assert.strictEqual(c.requestBody![0].name, 'id');
    assert.strictEqual(c.requestBody![0].required, true);
    assert.strictEqual(c.responses.length, 2);
    assert.strictEqual(c.responses[0].statusCode, 200);
    assert.strictEqual(c.responses[1].statusCode, 404);
  });

  await test('parseContractsFromSource 处理多个契约', () => {
    const source = `
/**
 * @api-contract
 * @module auth
 * @endpoint login
 * @method POST
 * @path /api/auth/login
 * @summary 用户登录
 * @description 验证凭证
 * @permission public
 */
function login() {}

/**
 * @api-contract
 * @module auth
 * @endpoint logout
 * @method POST
 * @path /api/auth/logout
 * @summary 用户登出
 * @description 清除会话
 * @permission auth
 */
function logout() {}
`;
    const contracts = parseContractsFromSource(source);
    assert.strictEqual(contracts.length, 2);
    assert.strictEqual(contracts[0].endpoint, 'login');
    assert.strictEqual(contracts[1].endpoint, 'logout');
  });

  await test('parseContractsFromSource 无契约返回空数组', () => {
    const contracts = parseContractsFromSource('const x = 1;');
    assert.strictEqual(contracts.length, 0);
  });

  await test('parseContractsFromSource 解析 mockData', () => {
    const source = `
/**
 * @api-contract
 * @module test
 * @endpoint mock
 * @method GET
 * @path /test
 * @summary test
 * @description test
 * @permission public
 * @mockData {"name": "test", "value": 42}
 */
`;
    const contracts = parseContractsFromSource(source);
    assert.strictEqual(contracts.length, 1);
    assert.deepStrictEqual(contracts[0].mockData, { name: 'test', value: 42 });
  });

  await test('parseContractsFromSource 解析 serverHint', () => {
    const source = `
/**
 * @api-contract
 * @module test
 * @endpoint hint
 * @method GET
 * @path /test
 * @summary test
 * @description test
 * @permission public
 * @serverHint
 * - 使用 Redis 缓存
 * - 限流 100 req/min
 */
`;
    const contracts = parseContractsFromSource(source);
    assert.strictEqual(contracts.length, 1);
    assert.ok(contracts[0].serverHints);
    assert.strictEqual(contracts[0].serverHints!.length, 2);
    assert.ok(contracts[0].serverHints![0].includes('Redis'));
  });

  await test('parseContractsFromDir 扫描目录', async () => {
    // 创建临时目录和文件
    const tmpDir = path.join(os.tmpdir(), `midou-contract-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'api.ts'), `
/**
 * @api-contract
 * @module orders
 * @endpoint listOrders
 * @method GET
 * @path /api/orders
 * @summary 获取订单列表
 * @description 分页获取订单
 * @permission orders:read
 */
`, 'utf-8');

    const contracts = await parseContractsFromDir(tmpDir);
    assert.strictEqual(contracts.length, 1);
    assert.strictEqual(contracts[0].module, 'orders');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
}

// ═══════════════════════════════════════════
// 3. 角色工具过滤测试
// ═══════════════════════════════════════════

async function testRoleFiltering() {
  console.log('\n=== Role-based Tool Filtering ===');

  const ctx = { systemManager: null, agentId: 'test-agent' };
  const coreTools = createCoreTools(ctx);

  await test('getAllToolDefinitions 无角色返回全部工具', () => {
    const defs = getAllToolDefinitions(coreTools);
    assert.ok(defs.length > 0);
    const names = defs.map(d => d.function.name);
    assert.ok(names.includes('finish_task'));
    assert.ok(names.includes('produce_artifact'));
    assert.ok(names.includes('submit_verdict'));
  });

  await test('getAllToolDefinitions 角色白名单过滤', () => {
    const role: AgentRole = {
      type: 'review',
      allowedTools: ['submit_verdict', 'consume_artifacts', 'finish_task'],
      canVerdict: true,
    };
    const defs = getAllToolDefinitions(coreTools, role);
    const names = defs.map(d => d.function.name);
    assert.strictEqual(names.length, 3);
    assert.ok(names.includes('submit_verdict'));
    assert.ok(names.includes('consume_artifacts'));
    assert.ok(names.includes('finish_task'));
    assert.ok(!names.includes('run_command'));
  });

  await test('getAllToolDefinitions 空白名单返回全部', () => {
    const role: AgentRole = { type: 'custom', allowedTools: [] };
    const defs = getAllToolDefinitions(coreTools, role);
    assert.ok(defs.length > 3); // 不为空白名单过滤
  });

  await test('createCoreTools 包含 pipeline 工具', () => {
    const names = coreTools.map(t => t.definition.function.name);
    assert.ok(names.includes('produce_artifact'));
    assert.ok(names.includes('consume_artifacts'));
    assert.ok(names.includes('parse_contracts'));
    assert.ok(names.includes('submit_verdict'));
  });
}

// ═══════════════════════════════════════════
// 4. Pipeline 类型完整性测试
// ═══════════════════════════════════════════

async function testPipelineTypes() {
  console.log('\n=== Pipeline Types ===');

  await test('PipelineDefinition 结构正确', () => {
    const pipeline = {
      id: 'test-pipeline',
      name: '测试流水线',
      projectDir: '/tmp/test',
      stages: [
        {
          id: 'design',
          name: '契约设计',
          agentId: 'agent-1',
          dependsOn: [],
          inputArtifacts: [],
          outputArtifacts: ['contract'] as const,
          promptTemplate: '设计 API 契约',
        },
        {
          id: 'review',
          name: '审查',
          agentId: 'agent-2',
          dependsOn: ['design'],
          inputArtifacts: ['contract'] as const,
          outputArtifacts: ['review-report'] as const,
          promptTemplate: '审查契约',
          isGate: true,
          onBlockReturnTo: 'design',
        },
      ],
    };

    assert.strictEqual(pipeline.stages.length, 2);
    assert.strictEqual(pipeline.stages[1].dependsOn[0], 'design');
    assert.strictEqual(pipeline.stages[1].isGate, true);
    assert.strictEqual(pipeline.stages[1].onBlockReturnTo, 'design');
  });

  await test('StageState 初始状态正确', () => {
    const state = {
      status: 'pending' as const,
      artifacts: [],
      retryCount: 0,
    };
    assert.strictEqual(state.status, 'pending');
    assert.strictEqual(state.artifacts.length, 0);
    assert.strictEqual(state.retryCount, 0);
  });
}

// ═══════════════════════════════════════════
// 运行所有测试
// ═══════════════════════════════════════════

async function main() {
  console.log('🔧 midou 流水线系统功能测试\n');

  await testArtifactStore();
  await testContractParser();
  await testRoleFiltering();
  await testPipelineTypes();

  console.log(`\n=============================`);
  console.log(`总计: ${passed + failed}  通过: ${passed}  失败: ${failed}`);
  console.log(`=============================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
