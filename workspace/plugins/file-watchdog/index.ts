/**
 * file-watchdog 插件 — 增量文件监控 + 本地摘要 + 定期 Agent 分析
 *
 * 数据流水线（逐层压缩）：
 *   Layer 0  原始增量事件  →  JSONL（仅记录 delta）
 *   Layer 1  事件分类       →  大规模操作检测（npm/git/build/cleanup）
 *   Layer 2  本地摘要       →  @huggingface/transformers 离线概括
 *   Layer 3  增量摘要日志   →  时间线 Markdown
 *   Layer 4  定期 Agent 分析 →  风险 + 图表 + 总结报告（增量追加）
 *   Layer 5  每日 05:40     →  汇总报告推送前端
 */

import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as parcelWatcher from '@parcel/watcher';
import * as cron from 'node-cron';

const execFileAsync = promisify(execFile);

// ────────────────────────────── 类型定义 ──────────────────────────────

type ChangeType = 'create' | 'update' | 'delete';

interface ToolDefinitionLike {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface AgentConfigLike {
  systemPrompt?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number | string | null;
}

interface AgentLike {
  id: string;
  name: string;
  config: AgentConfigLike;
  workspaceDir: string;
}

interface SystemManagerLike {
  agents: Map<string, AgentLike>;
  io: {
    emit: (event: string, data: unknown) => void;
  };
}

interface PluginContext {
  systemManager: SystemManagerLike;
  registerTool: (
    definition: ToolDefinitionLike,
    handler: (
      args: Record<string, unknown>,
      context: { systemManager: SystemManagerLike | null; agentId: string }
    ) => Promise<string> | string
  ) => void;
  quickAsk: (
    prompt: string,
    systemPrompt?: string,
    llmConfig?: Record<string, unknown>
  ) => Promise<string>;
  workspaceDir: string;
}

interface WatchTask {
  id: string;
  agentId: string;
  watchPath: string;
  intervalMs: number;
  createdAt: string;
  description?: string;
  enabled: boolean;
  lastRunAt?: string;
}

interface WatchRuntime {
  task: WatchTask;
  timer: NodeJS.Timeout;
  running: boolean;
}

interface WatchEventLike {
  type: ChangeType;
  path: string;
}

/** Layer 0 — 原始增量事件记录 */
interface RawIncrementalEntry {
  ts: string;
  taskId: string;
  events: Array<{ type: ChangeType; path: string }>;
}

/** Layer 1 — 大规模操作事件 */
interface BulkOperationEntry {
  ts: string;
  user: string;
  operation: string;
  kind: string;
  fileCount: number;
  details?: Record<string, unknown>;
}

/** Layer 1 — Git 操作事件 */
interface GitOperationEntry {
  ts: string;
  user: string;
  operation: string;
  branch?: string;
  prevBranch?: string;
  commitHash?: string;
  commitMessage?: string;
  diffSummary?: string;
  details?: Record<string, unknown>;
}

/** Layer 2 — 本地摘要条目 */
interface LocalSummaryEntry {
  ts: string;
  taskId: string;
  eventCount: number;
  kind: string;
  summary: string;
}

/** Layer 4 — Agent 分析报告段 */
interface AgentReportSection {
  ts: string;
  period: string;
  content: string;
}

// ────────────────────────────── 常量 ──────────────────────────────

const PLUGIN_NAME = 'file-watchdog';
const TASKS_FILE_NAME = 'tasks.json';
const BULK_THRESHOLD = 50;
const AGENT_ANALYSIS_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const ACTIVE_TASKS = new Map<string, WatchRuntime>();

// HuggingFace 本地摘要 pipeline（延迟初始化）
let _summarizer: unknown = null;
let _summarizerLoading = false;
let _summarizerReady = false;

// 定时器
let _agentAnalysisTimer: NodeJS.Timeout | null = null;
let _dailyCronTask: cron.ScheduledTask | null = null;

// 去重：记录每个仓库上次记录 auto-fetch 的时间戳（ms），30 分钟内不重复记录
const LAST_AUTO_FETCH_TS = new Map<string, number>();
// 去重：记录每个任务上次写入 timeline 的摘要内容，防止内容完全相同的连续条目
const LAST_TIMELINE_SUMMARY = new Map<string, string>();


// ────────────────────────────── 路径工具 ──────────────────────────────

function pluginDataDir(ctx: PluginContext): string {
  return path.join(ctx.workspaceDir, 'plugins', PLUGIN_NAME, 'data');
}
function snapshotsDir(ctx: PluginContext): string {
  return path.join(pluginDataDir(ctx), 'snapshots');
}
function tasksFilePath(ctx: PluginContext): string {
  return path.join(pluginDataDir(ctx), TASKS_FILE_NAME);
}
function logsRoot(ctx: PluginContext): string {
  return path.join(ctx.workspaceDir, 'logs', 'watchdog');
}
function snapshotFile(ctx: PluginContext, taskId: string): string {
  return path.join(snapshotsDir(ctx), `${taskId}.snapshot`);
}

// 按日期分层的日志目录
function dayLogsDir(ctx: PluginContext, day: string): string {
  return path.join(logsRoot(ctx), day);
}
function rawEventsFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'raw-events.jsonl');
}
function bulkOpsFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'bulk-operations.jsonl');
}
function gitOpsFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'git-operations.jsonl');
}
function localSummaryFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'local-summaries.jsonl');
}
function timelineFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'timeline.md');
}
function agentReportsFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'agent-reports.jsonl');
}
function dailyReportFile(ctx: PluginContext, day: string): string {
  return path.join(dayLogsDir(ctx, day), 'daily-report.md');
}

// ────────────────────────────── 通用工具 ──────────────────────────────

function pad(v: number): string { return v.toString().padStart(2, '0'); }
function formatDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatDateTime(d: Date): string {
  return `${formatDay(d)} ${formatTime(d)}`;
}
function normalizePath(p: string): string { return path.resolve(p); }
function relPath(root: string, p: string): string {
  return path.relative(root, p) || path.basename(p);
}
function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
function limitText(t: string, max: number): string {
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
function isPathInside(target: string, base: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function appendJsonl(filePath: string, entry: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
  } catch { return []; }
}

async function appendMarkdown(filePath: string, lines: string[]): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, lines.join('\n') + '\n\n', 'utf-8');
}

async function getCurrentUser(): Promise<string> {
  try {
    const r = await execFileAsync('whoami');
    return r.stdout.trim();
  } catch { return process.env.USER || process.env.USERNAME || 'unknown'; }
}

// ────────────────────────────── 任务持久化 ──────────────────────────────

async function readTasks(ctx: PluginContext): Promise<WatchTask[]> {
  try {
    const content = await fs.readFile(tasksFilePath(ctx), 'utf-8');
    const parsed = JSON.parse(content) as WatchTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveTasks(ctx: PluginContext, tasks: WatchTask[]): Promise<void> {
  await ensureDir(pluginDataDir(ctx));
  await fs.writeFile(tasksFilePath(ctx), JSON.stringify(tasks, null, 2), 'utf-8');
}

// ────────────────────────────── 内部路径过滤 ──────────────────────────────

function isInternalPath(ctx: PluginContext, eventPath: string): boolean {
  const abs = normalizePath(eventPath);
  if (isPathInside(abs, pluginDataDir(ctx))) return true;
  if (isPathInside(abs, logsRoot(ctx))) return true;
  const agentsDir = path.join(ctx.workspaceDir, 'agents');
  if (isPathInside(abs, agentsDir) && abs.includes(`${path.sep}watchdog${path.sep}`)) return true;
  return false;
}

// ────────────────────────────── HuggingFace 本地摘要 ──────────────────────────────

async function initSummarizer(): Promise<void> {
  if (_summarizerReady || _summarizerLoading) return;
  _summarizerLoading = true;
  try {
    const { pipeline } = await import('@huggingface/transformers');
    // 使用小型摘要模型，离线推理
    _summarizer = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6', {
      dtype: 'fp32',
    });
    _summarizerReady = true;
    console.log(`[${PLUGIN_NAME}] HuggingFace summarizer 已加载`);
  } catch (err) {
    console.warn(`[${PLUGIN_NAME}] HuggingFace summarizer 加载失败，将使用规则摘要:`, err);
    _summarizerReady = false;
  } finally {
    _summarizerLoading = false;
  }
}

async function localSummarize(text: string): Promise<string | null> {
  if (!_summarizerReady || !_summarizer) return null;
  try {
    const fn = _summarizer as (text: string, options?: Record<string, unknown>) => Promise<Array<{ summary_text: string }>>;
    const result = await fn(text, { max_length: 120, min_length: 20 });
    return result?.[0]?.summary_text?.trim() || null;
  } catch {
    return null;
  }
}

// ────────────────────────────── Layer 1：事件分类 ──────────────────────────────

function classifyEvents(watchPath: string, events: WatchEventLike[]): {
  regular: WatchEventLike[];
  nodeModules: WatchEventLike[];
  gitInternal: WatchEventLike[];
  buildArtifacts: WatchEventLike[];
  cacheCleanup: WatchEventLike[];
} {
  const regular: WatchEventLike[] = [];
  const nodeModules: WatchEventLike[] = [];
  const gitInternal: WatchEventLike[] = [];
  const buildArtifacts: WatchEventLike[] = [];
  const cacheCleanup: WatchEventLike[] = [];

  const buildDirs = new Set(['dist', 'build', '.next', 'coverage', '.turbo', '.cache', '__pycache__', '.tox']);
  const cacheDirs = ['.cache', '.local/share/Trash', 'yay', '.npm', '.pnpm-store'];

  for (const ev of events) {
    const rel = relPath(watchPath, ev.path);
    const parts = rel.split(path.sep);

    // 检查路径中任何层级是否包含特征目录（支持嵌套项目结构）
    const hasNodeModules = parts.some(p => p === 'node_modules');
    const hasGit = parts.some(p => p === '.git');
    const hasBuildDir = parts.some(p => buildDirs.has(p));
    const hasCacheDir = cacheDirs.some(d => rel.includes(d));

    if (hasNodeModules) {
      nodeModules.push(ev);
    } else if (hasGit) {
      gitInternal.push(ev);
    } else if (hasBuildDir) {
      buildArtifacts.push(ev);
    } else if (hasCacheDir) {
      cacheCleanup.push(ev);
    } else {
      regular.push(ev);
    }
  }

  return { regular, nodeModules, gitInternal, buildArtifacts, cacheCleanup };
}

// ────────────────────────────── Layer 1：大规模操作检测 ──────────────────────────────

async function detectBulkOperations(
  ctx: PluginContext,
  task: WatchTask,
  classified: ReturnType<typeof classifyEvents>,
  allEvents: WatchEventLike[],
): Promise<BulkOperationEntry[]> {
  const ops: BulkOperationEntry[] = [];
  const user = await getCurrentUser();
  const now = new Date().toISOString();

  // npm install / pnpm install / yarn install
  if (classified.nodeModules.length >= 30) {
    const creates = classified.nodeModules.filter(e => e.type === 'create').length;
    const deletes = classified.nodeModules.filter(e => e.type === 'delete').length;
    const operation = deletes > creates
      ? 'node_modules 清理（可能执行了 rm -rf node_modules 或 npm prune）'
      : '依赖安装/更新（可能执行了 npm install / pnpm install / yarn）';
    ops.push({
      ts: now, user, operation,
      kind: 'dependency_management',
      fileCount: classified.nodeModules.length,
      details: { creates, deletes, updates: classified.nodeModules.filter(e => e.type === 'update').length },
    });
  }

  // 构建产物批量变化
  if (classified.buildArtifacts.length >= 20) {
    ops.push({
      ts: now, user,
      operation: '构建产物批量变化（可能执行了 build / test / coverage 等命令）',
      kind: 'build_artifacts',
      fileCount: classified.buildArtifacts.length,
    });
  }

  // 缓存清理 (yay -Scc, npm cache clean, etc.)
  if (classified.cacheCleanup.length >= 20) {
    const hasYay = classified.cacheCleanup.some(e => e.path.includes('yay'));
    const operation = hasYay
      ? '系统包缓存清理（可能执行了 yay -Scc 或 pacman -Scc）'
      : '缓存目录批量清理';
    ops.push({
      ts: now, user, operation,
      kind: 'cache_cleanup',
      fileCount: classified.cacheCleanup.length,
    });
  }

  // 通用大规模变化（未被以上分类捕获的）
  if (ops.length === 0 && allEvents.length >= BULK_THRESHOLD) {
    const buckets = topBuckets(task.watchPath, allEvents, 5);
    ops.push({
      ts: now, user,
      operation: `大规模文件变更（${allEvents.length} 文件），主要在 ${buckets.join('、')}`,
      kind: 'bulk_generic',
      fileCount: allEvents.length,
    });
  }

  return ops;
}

function topBuckets(root: string, events: WatchEventLike[], limit = 5): string[] {
  const m = new Map<string, number>();
  for (const ev of events) {
    const rel = relPath(root, ev.path);
    const parts = rel.split(path.sep).filter(Boolean);
    const key = parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] || '.');
    m.set(key, (m.get(key) || 0) + 1);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k}(${v})`);
}

// ────────────────────────────── Layer 1：Git 操作追踪 ──────────────────────────────

async function gitRootFor(dir: string): Promise<string | null> {
  try {
    const r = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    return r.stdout.trim() || null;
  } catch { return null; }
}

async function detectGitOperations(
  ctx: PluginContext,
  task: WatchTask,
  gitEvents: WatchEventLike[],
): Promise<GitOperationEntry[]> {
  if (gitEvents.length === 0) return [];

  // 按仓库分组：watchPath 下可能有多个 git 仓库子目录
  const repoGroups = new Map<string, WatchEventLike[]>();
  for (const ev of gitEvents) {
    const rel = relPath(task.watchPath, ev.path);
    const parts = rel.split(path.sep);
    const gitIdx = parts.indexOf('.git');
    if (gitIdx < 0) continue;
    const repoAbsPath = gitIdx === 0
      ? task.watchPath
      : path.join(task.watchPath, ...parts.slice(0, gitIdx));
    if (!repoGroups.has(repoAbsPath)) repoGroups.set(repoAbsPath, []);
    repoGroups.get(repoAbsPath)!.push(ev);
  }

  const allOps: GitOperationEntry[] = [];
  for (const [repoRoot, events] of repoGroups) {
    const ops = await detectGitOpsForRepo(task.watchPath, repoRoot, events);
    allOps.push(...ops);
  }
  return allOps;
}

/** 分析单个仓库的 git 操作 */
async function detectGitOpsForRepo(
  watchPath: string, repoRoot: string, events: WatchEventLike[],
): Promise<GitOperationEntry[]> {
  const user = await getCurrentUser();
  const now = new Date().toISOString();
  const repoName = path.relative(watchPath, repoRoot) || path.basename(repoRoot);
  const ops: GitOperationEntry[] = [];

  // 分析 .git 内部文件变化模式（以 repoRoot 为基准取相对路径）
  const gitRelPaths = events.map(e => path.relative(repoRoot, e.path));

  const hasCommitEditMsg = gitRelPaths.some(p => p === path.join('.git', 'COMMIT_EDITMSG'));
  const hasOrigHead = events.some(e =>
    e.type === 'create' && path.relative(repoRoot, e.path) === path.join('.git', 'ORIG_HEAD'));
  const headChanged = gitRelPaths.some(p => p === path.join('.git', 'HEAD'));
  const hasPackedRefs = gitRelPaths.some(p => p === path.join('.git', 'packed-refs'));
  const hasFetchHead = gitRelPaths.some(p => p === path.join('.git', 'FETCH_HEAD'));
  const newObjects = gitRelPaths.filter(p =>
    p.startsWith(path.join('.git', 'objects')) && !p.includes('pack')).length;
  const packChanged = gitRelPaths.some(p =>
    p.startsWith(path.join('.git', 'objects', 'pack')));
  const remoteRefPaths = gitRelPaths.filter(p =>
    p.startsWith(path.join('.git', 'refs', 'remotes')));
  const branchRefPaths = gitRelPaths.filter(p =>
    p.startsWith(path.join('.git', 'refs', 'heads')));
  const logsHeadChanged = gitRelPaths.some(p =>
    p === path.join('.git', 'logs', 'HEAD'));

  // 获取当前分支、最近提交信息
  let currentBranch = '';
  let lastCommitHash = '';
  let lastCommitMsg = '';
  try {
    const br = await execFileAsync('git', ['-C', repoRoot, 'branch', '--show-current']);
    currentBranch = br.stdout.trim();
  } catch { /* ignore */ }
  try {
    const cm = await execFileAsync('git', ['-C', repoRoot, 'log', '-1', '--pretty=format:%H|||%B']);
    const sepIdx = cm.stdout.indexOf('|||');
    if (sepIdx >= 0) {
      lastCommitHash = cm.stdout.slice(0, sepIdx);
      lastCommitMsg = cm.stdout.slice(sepIdx + 3).trim();
    }
  } catch { /* ignore */ }

  // ── 检测规则（按优先级排列） ──

  // 1. git clone（大量 objects + packed-refs + 远程 refs 创建）
  if (newObjects > 100 && hasPackedRefs && remoteRefPaths.length > 0) {
    ops.push({
      ts: now, user, operation: 'git clone',
      branch: currentBranch,
      commitHash: lastCommitHash,
      commitMessage: lastCommitMsg,
      details: { repo: repoName, objectCount: newObjects, remoteRefCount: remoteRefPaths.length },
    });
    return ops;
  }

  // 2. git commit（最可靠信号：COMMIT_EDITMSG 出现 + objects 增加 + HEAD 日志更新）
  if (hasCommitEditMsg && newObjects > 0) {
    const diffSummary = await getGitDiffSummary(repoRoot);
    ops.push({
      ts: now, user, operation: 'git commit',
      branch: currentBranch,
      commitHash: lastCommitHash,
      commitMessage: lastCommitMsg,
      diffSummary,
      details: { repo: repoName, objectCount: newObjects },
    });
  }

  // 3. git pull / fetch（FETCH_HEAD 更新 + pack 或远程 refs 更新）
  //    注意：pull = fetch + merge，可能同时有 commit 特征
  if (hasFetchHead && (packChanged || remoteRefPaths.length > 0)) {
    // 如果同时有 ORIG_HEAD，说明是 pull（带 merge）
    const isPull = hasOrigHead || (logsHeadChanged && remoteRefPaths.length > 0 && branchRefPaths.length > 0);
    const opName = isPull ? 'git pull' : 'git fetch';
    // 避免和上面 commit 重复——如果已经记录了 commit 且是 pull，合并描述
    const existingCommit = ops.find(o => o.operation === 'git commit');
    if (existingCommit && isPull) {
      existingCommit.operation = 'git pull（含合并提交）';
      existingCommit.details = { ...existingCommit.details, remoteRefUpdates: remoteRefPaths.length };
    } else if (!existingCommit) {
      ops.push({
        ts: now, user, operation: opName,
        branch: currentBranch,
        commitHash: lastCommitHash,
        commitMessage: isPull ? lastCommitMsg : undefined,
        details: { repo: repoName, remoteRefUpdates: remoteRefPaths.length },
      });
    }
  }

  // 收集 branch 创建/删除情况（供后续规则使用）
  const branchCreates = new Set<string>();
  const branchDeletes = new Set<string>();
  for (const ev of events) {
    const rel = path.relative(repoRoot, ev.path);
    const prefix = path.join('.git', 'refs', 'heads') + path.sep;
    if (rel.startsWith(prefix)) {
      const branchName = rel.slice(prefix.length);
      if (branchName && !branchName.includes(path.sep)) {
        if (ev.type === 'create') branchCreates.add(branchName);
        if (ev.type === 'delete') branchDeletes.add(branchName);
      }
    }
  }

  // 4. git checkout / switch（HEAD 改变，但无 commit 信号）
  //    若同时有 branch 创建/删除，合并进同一条记录，避免产生两个重复条目
  if (headChanged && !hasCommitEditMsg && !hasFetchHead && events.length < 100) {
    const branchDesc: string[] = [];
    if (branchCreates.size > 0) branchDesc.push(`新建分支: ${Array.from(branchCreates).join(', ')}`);
    if (branchDeletes.size > 0) branchDesc.push(`删除分支: ${Array.from(branchDeletes).join(', ')}`);
    ops.push({
      ts: now, user, operation: 'git checkout / switch',
      branch: currentBranch,
      commitHash: lastCommitHash,
      commitMessage: lastCommitMsg,
      details: {
        repo: repoName,
        ...(branchDesc.length > 0 ? { branchChanges: branchDesc.join('; ') } : {}),
      },
    });
    // branch 事件已合并进 checkout，不再单独输出
    branchCreates.clear();
    branchDeletes.clear();
  }

  // 5. git branch 创建/删除（未被 checkout 合并时才单独记录）
  if (branchCreates.size > 0 || branchDeletes.size > 0) {
    const desc: string[] = [];
    if (branchCreates.size > 0) desc.push(`创建: ${Array.from(branchCreates).join(', ')}`);
    if (branchDeletes.size > 0) desc.push(`删除: ${Array.from(branchDeletes).join(', ')}`);
    ops.push({
      ts: now, user, operation: `git branch ${desc.join('; ')}`,
      branch: currentBranch,
      details: { repo: repoName },
    });
  }

  // 6. 仅有 FETCH_HEAD 更新（自动 fetch / cron 任务）
  //    30 分钟内同一仓库的 auto-fetch 不重复记录
  if (ops.length === 0 && hasFetchHead && events.length <= 3) {
    const autoFetchKey = repoRoot;
    const lastTs = LAST_AUTO_FETCH_TS.get(autoFetchKey) ?? 0;
    const now30MinAgo = Date.now() - 30 * 60 * 1000;
    if (lastTs < now30MinAgo) {
      LAST_AUTO_FETCH_TS.set(autoFetchKey, Date.now());
      ops.push({
        ts: now, user, operation: 'git fetch（自动/定时）',
        branch: currentBranch,
        details: { repo: repoName, eventCount: events.length },
      });
    }
    // 若在 30 分钟内已记录过，返回空（不产生新条目）
  }

  // 7. 兜底 — 有 git 变化但未归类
  if (ops.length === 0 && events.length > 5) {
    ops.push({
      ts: now, user,
      operation: `git 元数据变更（${events.length} 文件）`,
      branch: currentBranch,
      commitHash: lastCommitHash,
      commitMessage: lastCommitMsg,
      details: { repo: repoName },
    });
  }

  return ops;
}

/** 获取最近一次 commit 的 diff 统计摘要 */
async function getGitDiffSummary(repoRoot: string): Promise<string> {
  try {
    // 使用 git diff --stat 获取变更概要
    const r = await execFileAsync('git', [
      '-C', repoRoot,
      'diff', 'HEAD~1', '--stat', '--stat-width=80',
    ], { timeout: 10000 });
    const lines = r.stdout.trim().split('\n');
    if (lines.length > 0) {
      const summaryLine = lines[lines.length - 1];
      const fileChanges = lines.slice(0, Math.min(20, lines.length - 1));
      return [...fileChanges, summaryLine].join('\n');
    }
    return r.stdout.trim();
  } catch {
    try {
      const r = await execFileAsync('git', [
        '-C', repoRoot,
        'show', '--stat', '--pretty=format:', 'HEAD',
      ], { timeout: 10000 });
      return limitText(r.stdout.trim(), 1000);
    } catch { return ''; }
  }
}

// ────────────────────────────── Layer 2：本地摘要生成 ──────────────────────────────

/** 生成文件类型统计 */
function fileTypeStats(watchPath: string, events: WatchEventLike[]): string {
  const extMap = new Map<string, number>();
  for (const ev of events) {
    const rel = relPath(watchPath, ev.path);
    const ext = path.extname(rel).toLowerCase() || '(无扩展名)';
    extMap.set(ext, (extMap.get(ext) || 0) + 1);
  }
  return Array.from(extMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}×${count}`)
    .join(' ');
}

function buildRuleSummary(
  task: WatchTask,
  events: WatchEventLike[],
  classified: ReturnType<typeof classifyEvents>,
  bulkOps: BulkOperationEntry[],
  gitOps: GitOperationEntry[],
): string {
  const parts: string[] = [];

  // 常规文件变更详情
  if (classified.regular.length > 0) {
    const creates = classified.regular.filter(e => e.type === 'create');
    const updates = classified.regular.filter(e => e.type === 'update');
    const deletes = classified.regular.filter(e => e.type === 'delete');

    if (classified.regular.length <= 10) {
      // 少量文件：逐个列出
      const fileList = classified.regular.map(e => {
        const rel = relPath(task.watchPath, e.path);
        const action = e.type === 'create' ? '新建' : e.type === 'update' ? '修改' : '删除';
        return `${action} ${rel}`;
      });
      parts.push(`文件变更: ${fileList.join('；')}`);
    } else {
      // 较多文件：统计 + 目录分布 + 类型分布
      const buckets = topBuckets(task.watchPath, classified.regular, 4);
      const types = fileTypeStats(task.watchPath, classified.regular);
      parts.push(`常规文件变更 ${classified.regular.length} 个（+${creates.length} ~${updates.length} -${deletes.length}），目录: ${buckets.join('、')}，类型: ${types}`);
    }
  }

  // Git 操作信息
  if (gitOps.length > 0) {
    for (const op of gitOps) {
      const info = [op.operation];
      const repo = op.details?.repo ? `[${op.details.repo}]` : '';
      if (op.branch) info.push(`分支 ${op.branch}`);
      if (op.commitMessage) info.push(`"${limitText(op.commitMessage, 80)}"`);
      if (op.diffSummary) {
        const lastLine = op.diffSummary.split('\n').pop()?.trim();
        if (lastLine) info.push(lastLine);
      }
      parts.push(`Git${repo}: ${info.join(' | ')}`);
    }
  } else if (classified.gitInternal.length > 0) {
    parts.push(`.git 变更 ${classified.gitInternal.length} 个`);
  }

  // 大规模操作
  if (bulkOps.length > 0) {
    for (const op of bulkOps) {
      parts.push(`${op.operation}`);
    }
  }

  // 其他分类
  if (classified.nodeModules.length > 0 && !bulkOps.some(o => o.kind === 'dependency_management')) {
    parts.push(`node_modules 变更 ${classified.nodeModules.length} 个`);
  }
  if (classified.buildArtifacts.length > 0 && !bulkOps.some(o => o.kind === 'build_artifacts')) {
    parts.push(`构建产物变更 ${classified.buildArtifacts.length} 个`);
  }
  if (classified.cacheCleanup.length > 0 && !bulkOps.some(o => o.kind === 'cache_cleanup')) {
    parts.push(`缓存变更 ${classified.cacheCleanup.length} 个`);
  }

  return parts.length > 0
    ? `[${events.length}文件] ${parts.join('；')}`
    : `目录内容发生 ${events.length} 个文件变化`;
}

async function generateLocalSummary(
  ctx: PluginContext,
  task: WatchTask,
  events: WatchEventLike[],
  classified: ReturnType<typeof classifyEvents>,
  bulkOps: BulkOperationEntry[],
  gitOps: GitOperationEntry[],
): Promise<LocalSummaryEntry> {
  const now = new Date().toISOString();

  // 始终使用规则摘要作为主要摘要（HF 模型对结构化日志数据效果差）
  const summary = buildRuleSummary(task, events, classified, bulkOps, gitOps);
  return { ts: now, taskId: task.id, eventCount: events.length, kind: 'rule_summary', summary };
}

// ────────────────────────────── Layer 3：增量日志写入 ──────────────────────────────

async function writeIncrementalLogs(
  ctx: PluginContext,
  task: WatchTask,
  events: WatchEventLike[],
  classified: ReturnType<typeof classifyEvents>,
  bulkOps: BulkOperationEntry[],
  gitOps: GitOperationEntry[],
  localSummary: LocalSummaryEntry,
): Promise<void> {
  const day = formatDay(new Date());

  // Layer 0: 原始增量事件（只记录 delta，不记录全量）
  const rawEntry: RawIncrementalEntry = {
    ts: new Date().toISOString(),
    taskId: task.id,
    events: events.slice(0, 500).map(e => ({
      type: e.type,
      path: relPath(task.watchPath, e.path),
    })),
  };
  // 注入分类统计和 git/bulk 操作摘要，便于后续查询
  const rawMeta: Record<string, unknown> = {
    ...rawEntry,
    stats: {
      regular: classified.regular.length,
      git: classified.gitInternal.length,
      nodeModules: classified.nodeModules.length,
      build: classified.buildArtifacts.length,
      cache: classified.cacheCleanup.length,
    },
  };
  if (gitOps.length > 0) {
    rawMeta.gitOps = gitOps.map(op => ({
      operation: op.operation,
      repo: op.details?.repo,
      branch: op.branch,
      commitHash: op.commitHash?.slice(0, 12),
      commitMessage: op.commitMessage,
    }));
  }
  if (bulkOps.length > 0) {
    rawMeta.bulkOps = bulkOps.map(op => ({ kind: op.kind, operation: op.operation, fileCount: op.fileCount }));
  }
  // 常规文件变更明细（少于 30 个时逐条记录）
  if (classified.regular.length > 0 && classified.regular.length <= 30) {
    rawMeta.regularFiles = classified.regular.map(e => ({
      type: e.type,
      path: relPath(task.watchPath, e.path),
    }));
  }
  await appendJsonl(rawEventsFile(ctx, day), rawMeta);

  // Layer 1: 大规模操作日志
  for (const op of bulkOps) {
    await appendJsonl(bulkOpsFile(ctx, day), op);
  }

  // Layer 1: Git 操作日志
  for (const op of gitOps) {
    await appendJsonl(gitOpsFile(ctx, day), op);
  }

  // Layer 2: 本地摘要
  await appendJsonl(localSummaryFile(ctx, day), localSummary);

  // Layer 3: 时间线 Markdown（人可读的增量记录）
  const now = new Date();
  const timelineLines: string[] = [
    `### ${formatTime(now)} | ${task.id}`,
    '',
    `- 目录：\`${task.watchPath}\``,
    `- 事件：${events.length} 个文件变化`,
    `- 摘要：${localSummary.summary}`,
  ];

  // 常规文件变更明细
  if (classified.regular.length > 0 && classified.regular.length <= 20) {
    timelineLines.push('- 文件变更明细：');
    for (const ev of classified.regular) {
      const rel = relPath(task.watchPath, ev.path);
      const icon = ev.type === 'create' ? '🆕' : ev.type === 'update' ? '✏️' : '🗑️';
      timelineLines.push(`  - ${icon} ${rel}`);
    }
  } else if (classified.regular.length > 20) {
    const types = fileTypeStats(task.watchPath, classified.regular);
    const buckets = topBuckets(task.watchPath, classified.regular, 5);
    timelineLines.push(`- 文件类型分布：${types}`);
    timelineLines.push(`- 目录分布：${buckets.join('、')}`);
  }

  // 大规模操作
  if (bulkOps.length > 0) {
    timelineLines.push('- 大规模操作：');
    for (const op of bulkOps) {
      timelineLines.push(`  - 【${op.user}】${op.operation}（${op.fileCount} 文件）`);
    }
  }

  // Git 操作详情
  if (gitOps.length > 0) {
    timelineLines.push('- Git 操作：');
    for (const op of gitOps) {
      const repo = op.details?.repo ? `[${op.details.repo}] ` : '';
      const info = [`${repo}${op.operation}`];
      if (op.branch) info.push(`分支: ${op.branch}`);
      if (op.commitHash) info.push(`提交: ${op.commitHash.slice(0, 8)}`);
      timelineLines.push(`  - 【${op.user}】${info.join(' | ')}`);
      if (op.commitMessage) {
        timelineLines.push(`    提交信息: ${op.commitMessage}`);
      }
      if (op.diffSummary) {
        const diffLines = op.diffSummary.split('\n').slice(0, 10);
        timelineLines.push('    变更统计:');
        for (const dl of diffLines) {
          timelineLines.push(`      ${dl}`);
        }
      }
    }
  }

  // 连续重复摘要去重：若本次摘要与上次完全相同，在时间线里注记而非完整重复
  const summaryKey = task.id;
  const prevSummary = LAST_TIMELINE_SUMMARY.get(summaryKey);
  if (prevSummary === localSummary.summary) {
    // 摘要与上次相同，仅追加一行简短记录，不展开细节
    await appendMarkdown(timelineFile(ctx, day), [
      `### ${formatTime(now)} | ${task.id}`,
      '',
      `- 事件：${events.length} 个文件变化（内容与上一条相同，已省略细节）`,
    ]);
  } else {
    LAST_TIMELINE_SUMMARY.set(summaryKey, localSummary.summary);
    await appendMarkdown(timelineFile(ctx, day), timelineLines);
  }
}

// ────────────────────────────── Layer 4：定期 Agent 分析 ──────────────────────────────

async function runAgentAnalysis(ctx: PluginContext): Promise<void> {
  const day = formatDay(new Date());
  console.log(`[${PLUGIN_NAME}] 开始定期 Agent 分析...`);

  // 读取当日所有增量数据
  const summaries = await readJsonl<LocalSummaryEntry>(localSummaryFile(ctx, day));
  const bulkOps = await readJsonl<BulkOperationEntry>(bulkOpsFile(ctx, day));
  const gitOps = await readJsonl<GitOperationEntry>(gitOpsFile(ctx, day));
  const existingReports = await readJsonl<AgentReportSection>(agentReportsFile(ctx, day));

  // 计算上次分析之后的新数据
  const lastAnalysisTs = existingReports.length > 0
    ? existingReports[existingReports.length - 1].ts
    : '';
  const newSummaries = lastAnalysisTs
    ? summaries.filter(s => s.ts > lastAnalysisTs)
    : summaries;
  const newBulkOps = lastAnalysisTs
    ? bulkOps.filter(o => o.ts > lastAnalysisTs)
    : bulkOps;
  const newGitOps = lastAnalysisTs
    ? gitOps.filter(o => o.ts > lastAnalysisTs)
    : gitOps;

  if (newSummaries.length === 0 && newBulkOps.length === 0 && newGitOps.length === 0) {
    console.log(`[${PLUGIN_NAME}] 无新数据需要分析`);
    return;
  }

  // 构建分析 prompt
  const promptParts: string[] = [
    '你是一个系统安全和开发活动分析专家。请分析以下文件监控数据，生成增量分析报告。',
    '',
    '## 要求',
    '1. 使用 Markdown 格式',
    '2. 包含以下章节：',
    '   - **活动概述**：本时段发生了什么',
    '   - **操作统计**（用文本描述适合图表展示的数据，例如 "文件变更分布: 常规文件 45%, 依赖 30%, 构建产物 25%"）',
    '   - **Git 活动**：分支、提交、合并等关键操作',
    '   - **风险分析**：识别可能的风险行为、风险代码变更、风险操作',
    '     - 例如：大规模删除、敏感文件改动、异常时间的操作、未经审查的强制推送等',
    '   - **建议**：如有风险，给出改进建议',
    '3. 该简洁的地方简洁，该详细的地方详细',
    '4. 特别关注安全相关的变更和风险操作',
    '',
    `## 分析时段`,
    `日期：${day}`,
    `上次分析时间：${lastAnalysisTs || '首次分析'}`,
    `当前时间：${new Date().toISOString()}`,
    '',
  ];

  if (newSummaries.length > 0) {
    promptParts.push('## 文件变更摘要');
    for (const s of newSummaries.slice(-30)) {
      promptParts.push(`- [${s.ts}] ${s.taskId}: ${s.summary} (${s.eventCount}文件, ${s.kind})`);
    }
    promptParts.push('');
  }

  if (newBulkOps.length > 0) {
    promptParts.push('## 大规模操作记录');
    for (const op of newBulkOps) {
      promptParts.push(`- [${op.ts}] 用户: ${op.user} | 操作: ${op.operation} | 文件数: ${op.fileCount} | 类型: ${op.kind}`);
    }
    promptParts.push('');
  }

  if (newGitOps.length > 0) {
    promptParts.push('## Git 操作记录');
    for (const op of newGitOps) {
      const info = [`操作: ${op.operation}`, `用户: ${op.user}`];
      if (op.branch) info.push(`分支: ${op.branch}`);
      if (op.commitHash) info.push(`提交: ${op.commitHash.slice(0, 8)}`);
      if (op.commitMessage) info.push(`信息: ${limitText(op.commitMessage, 100)}`);
      if (op.diffSummary) info.push(`变更概要:\n${limitText(op.diffSummary, 500)}`);
      promptParts.push(`- [${op.ts}] ${info.join(' | ')}`);
    }
    promptParts.push('');
  }

  // 获取第一个可用的 agent 配置来调用 LLM
  const agent = ctx.systemManager.agents.values().next().value as AgentLike | undefined;
  const llmConfig = agent ? buildLLMConfig(agent) : undefined;

  try {
    const report = await ctx.quickAsk(
      promptParts.join('\n'),
      '你是一个资深的 DevOps 和安全分析专家。你的任务是分析文件系统监控数据，识别开发活动模式和潜在风险。输出务必专业、客观。',
      llmConfig,
    );

    const section: AgentReportSection = {
      ts: new Date().toISOString(),
      period: `${lastAnalysisTs || day + ' 00:00:00'} → ${new Date().toISOString()}`,
      content: report.trim(),
    };

    // 增量追加到报告文件
    await appendJsonl(agentReportsFile(ctx, day), section);
    console.log(`[${PLUGIN_NAME}] Agent 分析完成，已追加报告`);
  } catch (err) {
    console.error(`[${PLUGIN_NAME}] Agent 分析失败:`, err);
  }
}

function buildLLMConfig(agent: AgentLike): Record<string, unknown> | undefined {
  const maxTokens = typeof agent.config.maxTokens === 'string'
    ? Number(agent.config.maxTokens)
    : agent.config.maxTokens;
  const config: Record<string, unknown> = {};
  if (agent.config.provider) config.provider = agent.config.provider;
  if (agent.config.model) config.model = agent.config.model;
  if (agent.config.apiKey) config.apiKey = agent.config.apiKey;
  if (agent.config.baseURL) config.baseURL = agent.config.baseURL;
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    config.maxTokens = maxTokens;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

// ────────────────────────────── Layer 5：每日 05:40 汇总报告 ──────────────────────────────

async function generateDailyReport(ctx: PluginContext): Promise<void> {
  const day = formatDay(new Date());
  console.log(`[${PLUGIN_NAME}] 生成每日汇总报告 ${day}...`);

  // 收集当日所有数据
  const summaries = await readJsonl<LocalSummaryEntry>(localSummaryFile(ctx, day));
  const bulkOps = await readJsonl<BulkOperationEntry>(bulkOpsFile(ctx, day));
  const gitOps = await readJsonl<GitOperationEntry>(gitOpsFile(ctx, day));
  const agentReports = await readJsonl<AgentReportSection>(agentReportsFile(ctx, day));

  if (summaries.length === 0 && bulkOps.length === 0 && gitOps.length === 0) {
    console.log(`[${PLUGIN_NAME}] 今日无监控数据，跳过汇总`);
    return;
  }

  // 构建汇总 prompt
  const promptParts: string[] = [
    `你是一个资深的 DevOps 和安全分析专家。请生成 ${day} 的每日文件监控汇总报告。`,
    '',
    '## 输出要求',
    '1. 使用 Markdown 格式',
    '2. 包含以下章节：',
    '   - **📊 今日概览**：当日整体活动统计',
    '   - **📈 活动统计**：',
    '     - 文件变更类型分布（用 Mermaid pie 图表）',
    '     - 时间段活动分布（用 Mermaid bar 图表）',
    '     - 活跃目录排名（表格）',
    '   - **🔀 Git 活动汇总**：所有 Git 操作的时间线',
    '   - **⚠️ 风险分析与预警**：',
    '     - 识别潜在风险行为（大规模删除、敏感文件变更、异常操作、可疑时间段活动）',
    '     - 对涉及的风险代码变更给出分析',
    '     - 风险等级评估（低/中/高/严重）',
    '   - **💡 改进建议**：基于风险分析提出的建议',
    '   - **📝 详细活动时间线**：按时间排列的关键事件',
    '3. 该简洁的地方简洁，该详细的地方详细，不限字数',
    '4. 图表使用 Mermaid 语法以便前端渲染',
    '',
    `## 今日数据（${day}）`,
    `- 监控快照次数：${summaries.length}`,
    `- 大规模操作次数：${bulkOps.length}`,
    `- Git 操作次数：${gitOps.length}`,
    `- 累计文件事件：${summaries.reduce((s, e) => s + e.eventCount, 0)}`,
    '',
  ];

  // 先前的 Agent 分析段落
  if (agentReports.length > 0) {
    promptParts.push('## 此前的分时段分析');
    for (const r of agentReports) {
      promptParts.push(`### 时段: ${r.period}`);
      promptParts.push(limitText(r.content, 1500));
      promptParts.push('');
    }
  }

  // 增量摘要
  if (summaries.length > 0) {
    promptParts.push('## 所有增量监控摘要');
    for (const s of summaries.slice(-50)) {
      promptParts.push(`- [${s.ts}] ${s.taskId}: ${s.summary}`);
    }
    promptParts.push('');
  }

  // 大规模操作
  if (bulkOps.length > 0) {
    promptParts.push('## 大规模操作日志');
    for (const op of bulkOps) {
      promptParts.push(`- [${op.ts}] 👤${op.user} | ${op.operation} | ${op.fileCount}文件 | ${op.kind}`);
    }
    promptParts.push('');
  }

  // Git 操作
  if (gitOps.length > 0) {
    promptParts.push('## Git 操作日志');
    for (const op of gitOps) {
      const info = [`${op.operation}`, `👤${op.user}`];
      if (op.branch) info.push(`🔀${op.branch}`);
      if (op.commitHash) info.push(`#${op.commitHash.slice(0, 8)}`);
      if (op.commitMessage) info.push(`"${limitText(op.commitMessage, 80)}"`);
      if (op.diffSummary) info.push(`变更: ${limitText(op.diffSummary, 300)}`);
      promptParts.push(`- [${op.ts}] ${info.join(' | ')}`);
    }
    promptParts.push('');
  }

  const agent = ctx.systemManager.agents.values().next().value as AgentLike | undefined;
  const llmConfig = agent ? buildLLMConfig(agent) : undefined;

  let report = '';
  try {
    report = await ctx.quickAsk(
      promptParts.join('\n'),
      '你是一个资深的 DevOps 和安全分析专家。请基于提供的文件监控数据生成专业的每日报告。使用 Mermaid 图表增强可视化。输出务必全面、专业、客观。',
      llmConfig,
    );
  } catch (err) {
    console.error(`[${PLUGIN_NAME}] 每日报告 LLM 调用失败，使用兜底报告:`, err);
    report = buildFallbackDailyReport(day, summaries, bulkOps, gitOps);
  }

  const finalReport = report.trim() || buildFallbackDailyReport(day, summaries, bulkOps, gitOps);

  // 写入报告文件
  const reportPath = dailyReportFile(ctx, day);
  await ensureDir(path.dirname(reportPath));
  await fs.writeFile(reportPath, `${finalReport}\n`, 'utf-8');

  // 推送到前端
  ctx.systemManager.io.emit('watchdog:daily-report', {
    day,
    report: finalReport,
    stats: {
      snapshotCount: summaries.length,
      bulkOpsCount: bulkOps.length,
      gitOpsCount: gitOps.length,
      totalFileEvents: summaries.reduce((s, e) => s + e.eventCount, 0),
    },
    generatedAt: new Date().toISOString(),
  });

  console.log(`[${PLUGIN_NAME}] 每日报告已生成并推送到前端`);
}

function buildFallbackDailyReport(
  day: string,
  summaries: LocalSummaryEntry[],
  bulkOps: BulkOperationEntry[],
  gitOps: GitOperationEntry[],
): string {
  const totalEvents = summaries.reduce((s, e) => s + e.eventCount, 0);
  const lines: string[] = [
    `# 📋 文件监控日报 — ${day}`,
    '',
    `> 生成时间：${formatDateTime(new Date())}`,
    '',
    '## 📊 今日概览',
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 监控快照次数 | ${summaries.length} |`,
    `| 大规模操作 | ${bulkOps.length} |`,
    `| Git 操作 | ${gitOps.length} |`,
    `| 累计文件事件 | ${totalEvents} |`,
    '',
  ];

  if (bulkOps.length > 0) {
    lines.push('## 🔧 大规模操作');
    lines.push('');
    for (const op of bulkOps) {
      lines.push(`- **${formatDateTime(new Date(op.ts))}** — 👤${op.user} — ${op.operation}（${op.fileCount} 文件）`);
    }
    lines.push('');
  }

  if (gitOps.length > 0) {
    lines.push('## 🔀 Git 活动');
    lines.push('');
    for (const op of gitOps) {
      const parts = [op.operation];
      if (op.branch) parts.push(`分支: ${op.branch}`);
      if (op.commitMessage) parts.push(`"${op.commitMessage}"`);
      lines.push(`- **${formatDateTime(new Date(op.ts))}** — 👤${op.user} — ${parts.join(' | ')}`);
    }
    lines.push('');
  }

  if (summaries.length > 0) {
    lines.push('## 📝 活动时间线（最近 20 条）');
    lines.push('');
    for (const s of summaries.slice(-20)) {
      lines.push(`- **${s.ts}** — ${s.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ────────────────────────────── 核心执行逻辑 ──────────────────────────────

async function ensureSnapshot(ctx: PluginContext, task: WatchTask): Promise<void> {
  await ensureDir(snapshotsDir(ctx));
  const sf = snapshotFile(ctx, task.id);
  if (!(await fileExists(sf))) {
    await parcelWatcher.writeSnapshot(task.watchPath, sf);
  }
}

async function runTask(ctx: PluginContext, taskId: string): Promise<string | null> {
  const runtime = ACTIVE_TASKS.get(taskId);
  if (!runtime || runtime.running || !runtime.task.enabled) return null;

  runtime.running = true;
  try {
    const task = runtime.task;
    await ensureSnapshot(ctx, task);

    const sf = snapshotFile(ctx, task.id);
    const rawEvents = await parcelWatcher.getEventsSince(task.watchPath, sf);
    await parcelWatcher.writeSnapshot(task.watchPath, sf);

    const events = (rawEvents as WatchEventLike[])
      .map(e => ({ type: e.type, path: normalizePath(e.path) }))
      .filter(e => !isInternalPath(ctx, e.path));

    task.lastRunAt = new Date().toISOString();
    const tasks = await readTasks(ctx);
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = task;
      await saveTasks(ctx, tasks);
    }

    if (events.length === 0) return null;

    // Layer 1: 分类
    const classified = classifyEvents(task.watchPath, events);

    // Layer 1: 大规模操作检测
    const bulkOps = await detectBulkOperations(ctx, task, classified, events);

    // Layer 1: Git 操作检测
    const gitOps = await detectGitOperations(ctx, task, classified.gitInternal);

    // ── 过滤：跳过纯 auto-fetch 且没有任何真实文件变更的快照 ──
    // 条件：没有常规文件变更、没有大规模操作、所有 git 操作都是 auto-fetch（或者 gitOps 为空）
    const hasRealChanges =
      classified.regular.length > 0 ||
      classified.nodeModules.length > 0 ||
      classified.buildArtifacts.length > 0 ||
      classified.cacheCleanup.length > 0 ||
      bulkOps.length > 0 ||
      gitOps.some(op => !op.operation.includes('自动/定时'));
    if (!hasRealChanges) {
      // 什么有意义的事情都没发生，静默跳过，不写日志
      return null;
    }

    // Layer 2: 本地摘要
    const localSummary = await generateLocalSummary(ctx, task, events, classified, bulkOps, gitOps);

    // Layer 3: 增量写入日志
    await writeIncrementalLogs(ctx, task, events, classified, bulkOps, gitOps, localSummary);

    return localSummary.summary;
  } catch (err) {
    console.error(`[${PLUGIN_NAME}] 任务 ${taskId} 执行失败:`, err);
    return null;
  } finally {
    runtime.running = false;
  }
}

async function startTask(ctx: PluginContext, task: WatchTask): Promise<void> {
  const existing = ACTIVE_TASKS.get(task.id);
  if (existing) {
    clearInterval(existing.timer);
    ACTIVE_TASKS.delete(task.id);
  }

  await ensureSnapshot(ctx, task);
  const timer = setInterval(() => {
    runTask(ctx, task.id).catch(err => {
      console.error(`[${PLUGIN_NAME}] 定时任务 ${task.id} 出错:`, err);
    });
  }, task.intervalMs);

  ACTIVE_TASKS.set(task.id, { task, timer, running: false });
}

async function stopTask(ctx: PluginContext, taskId: string, agentId?: string): Promise<string> {
  const tasks = await readTasks(ctx);
  const task = tasks.find(t => t.id === taskId && (!agentId || t.agentId === agentId));
  if (!task) return `未找到监控任务: ${taskId}`;

  task.enabled = false;
  const runtime = ACTIVE_TASKS.get(task.id);
  if (runtime) {
    clearInterval(runtime.timer);
    ACTIVE_TASKS.delete(task.id);
  }
  await saveTasks(ctx, tasks);
  return `已停止监控任务 ${task.id}（目录: ${task.watchPath}）`;
}

async function deleteTask(ctx: PluginContext, taskId: string, agentId?: string): Promise<string> {
  const tasks = await readTasks(ctx);
  const idx = tasks.findIndex(t => t.id === taskId && (!agentId || t.agentId === agentId));
  if (idx < 0) return `未找到监控任务: ${taskId}`;

  const [task] = tasks.splice(idx, 1);
  const runtime = ACTIVE_TASKS.get(task.id);
  if (runtime) {
    clearInterval(runtime.timer);
    ACTIVE_TASKS.delete(task.id);
  }
  const sf = snapshotFile(ctx, task.id);
  await fs.rm(sf, { force: true }).catch(() => {});
  await saveTasks(ctx, tasks);
  return `已删除监控任务 ${task.id}（目录: ${task.watchPath}），历史日志已保留`;
}

async function runTaskOnce(ctx: PluginContext, taskId: string, agentId?: string): Promise<string> {
  const tasks = await readTasks(ctx);
  const task = tasks.find(t => t.id === taskId && (!agentId || t.agentId === agentId));
  if (!task) return `未找到监控任务: ${taskId}`;
  if (!task.enabled) return `监控任务 ${task.id} 已停止，请先恢复`;

  if (!ACTIVE_TASKS.has(task.id)) {
    await startTask(ctx, task);
  }

  const summary = await runTask(ctx, task.id);
  if (!summary) {
    return `已执行 ${task.id} — 本次无新文件变化`;
  }
  return `已执行 ${task.id} — ${summary}`;
}

function formatTaskStatus(task: WatchTask): string {
  if (!task.enabled) return '已停止';
  if (ACTIVE_TASKS.has(task.id)) return '运行中';
  return '待恢复';
}

async function listTasks(ctx: PluginContext, agentId?: string, includeStopped = true): Promise<string> {
  const tasks = await readTasks(ctx);
  const filtered = tasks.filter(t =>
    (!agentId || t.agentId === agentId) && (includeStopped || t.enabled)
  );
  if (filtered.length === 0) {
    return agentId ? `Agent ${agentId} 无监控任务` : '无任何监控任务';
  }
  const lines = filtered.map(t => [
    `- **${t.id}** [${formatTaskStatus(t)}]`,
    `  目录: ${t.watchPath}`,
    `  周期: ${Math.floor(t.intervalMs / 60000)}分钟`,
    `  上次执行: ${t.lastRunAt ? formatDateTime(new Date(t.lastRunAt)) : '未执行'}`,
    t.description ? `  备注: ${t.description}` : '',
  ].filter(Boolean).join('\n'));

  return `监控任务 (${filtered.length}):\n\n${lines.join('\n\n')}`;
}

async function createWatchTask(
  ctx: PluginContext,
  agentId: string,
  watchPathInput: string,
  intervalMinutes: number,
  description?: string,
): Promise<string> {
  const watchPath = normalizePath(watchPathInput);
  const stat = await fs.stat(watchPath).catch(() => null);
  if (!stat?.isDirectory()) {
    return `目录不存在或不可访问: ${watchPath}`;
  }

  const intervalMs = Math.max(1, Math.floor(intervalMinutes)) * 60 * 1000;
  const tasks = await readTasks(ctx);

  // 查找已有任务
  const existing = tasks.find(
    t => t.agentId === agentId && t.watchPath === watchPath && t.intervalMs === intervalMs && t.enabled
  );
  if (existing) {
    await startTask(ctx, existing);
    return `任务已存在: ${existing.id}（目录: ${existing.watchPath}，周期: ${Math.floor(existing.intervalMs / 60000)}分钟）`;
  }

  // 查找已停止任务，恢复
  const stopped = tasks.find(
    t => t.agentId === agentId && t.watchPath === watchPath && t.intervalMs === intervalMs && !t.enabled
  );
  if (stopped) {
    stopped.enabled = true;
    stopped.description = description?.trim() || stopped.description;
    await saveTasks(ctx, tasks);
    await startTask(ctx, stopped);
    return `已恢复任务: ${stopped.id}（目录: ${stopped.watchPath}）`;
  }

  const task: WatchTask = {
    id: `${sanitizeId(agentId)}-${Date.now()}`,
    agentId,
    watchPath,
    intervalMs,
    createdAt: new Date().toISOString(),
    description: description?.trim() || undefined,
    enabled: true,
  };

  tasks.push(task);
  await saveTasks(ctx, tasks);
  await startTask(ctx, task);

  return [
    `已创建监控任务: ${task.id}`,
    `目录: ${task.watchPath}`,
    `周期: ${Math.floor(task.intervalMs / 60000)} 分钟`,
    `日志位置: ${dayLogsDir(ctx, formatDay(new Date()))}`,
    description ? `备注: ${description}` : '',
  ].filter(Boolean).join('\n');
}

async function restoreTasks(ctx: PluginContext): Promise<void> {
  const tasks = await readTasks(ctx);
  for (const task of tasks) {
    if (!task.enabled) continue;
    try {
      await startTask(ctx, task);
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 恢复任务 ${task.id} 失败:`, err);
    }
  }
}

async function getTodayReport(ctx: PluginContext): Promise<string> {
  const day = formatDay(new Date());
  const reportPath = dailyReportFile(ctx, day);
  if (await fileExists(reportPath)) {
    return await fs.readFile(reportPath, 'utf-8');
  }
  const tlPath = timelineFile(ctx, day);
  if (await fileExists(tlPath)) {
    return `# 今日监控时间线（${day}）\n\n` + await fs.readFile(tlPath, 'utf-8');
  }
  return `今日（${day}）暂无监控数据`;
}

async function getReportByDate(ctx: PluginContext, date: string): Promise<string> {
  const reportPath = dailyReportFile(ctx, date);
  if (await fileExists(reportPath)) {
    return await fs.readFile(reportPath, 'utf-8');
  }
  const tlPath = timelineFile(ctx, date);
  if (await fileExists(tlPath)) {
    return `# 监控时间线（${date}）\n\n` + await fs.readFile(tlPath, 'utf-8');
  }
  return `${date} 无监控数据`;
}

// ────────────────────────────── 插件导出 ──────────────────────────────

export default {
  name: PLUGIN_NAME,
  async install(ctx: PluginContext): Promise<void> {
    // 初始化目录
    await ensureDir(pluginDataDir(ctx));
    await ensureDir(snapshotsDir(ctx));
    await ensureDir(logsRoot(ctx));

    // 异步加载 HuggingFace summarizer（不阻塞插件启动）
    initSummarizer().catch(err => {
      console.warn(`[${PLUGIN_NAME}] Summarizer 初始化异常:`, err);
    });

    // ── 注册工具 ──

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_create_watch_task',
          description: '创建目录监控任务。增量记录文件变化，自动检测大规模操作（npm install/git/build等），本地摘要并定期生成分析报告。',
          parameters: {
            type: 'object',
            properties: {
              directory: { type: 'string', description: '要监控的目录路径（绝对或相对于工作区）' },
              interval_minutes: { type: 'number', description: '检查间隔（分钟）' },
              description: { type: 'string', description: '任务说明（可选）' },
            },
            required: ['directory', 'interval_minutes'],
          },
        },
      },
      async (args, toolCtx) => {
        const dir = path.isAbsolute(args.directory as string)
          ? (args.directory as string)
          : path.resolve(ctx.workspaceDir, args.directory as string);
        return createWatchTask(ctx, toolCtx.agentId, dir, Number(args.interval_minutes),
          typeof args.description === 'string' ? args.description : undefined);
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_list_watch_tasks',
          description: '列出监控任务',
          parameters: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'Agent ID（默认当前）' },
              include_stopped: { type: 'boolean', description: '是否包含已停止任务（默认 true）' },
            },
            required: [],
          },
        },
      },
      async (args, toolCtx) => {
        const agentId = typeof args.agent_id === 'string' && args.agent_id ? args.agent_id : toolCtx.agentId;
        const includeStopped = typeof args.include_stopped === 'boolean' ? args.include_stopped : true;
        return listTasks(ctx, agentId, includeStopped);
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_run_watch_task_once',
          description: '立即执行一次监控任务',
          parameters: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: '任务 ID' },
              agent_id: { type: 'string', description: 'Agent ID（默认当前）' },
            },
            required: ['task_id'],
          },
        },
      },
      async (args, toolCtx) => {
        const agentId = typeof args.agent_id === 'string' && args.agent_id ? args.agent_id : toolCtx.agentId;
        return runTaskOnce(ctx, String(args.task_id), agentId);
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_stop_watch_task',
          description: '停止监控任务（保留配置，可恢复）',
          parameters: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: '任务 ID' },
              agent_id: { type: 'string', description: 'Agent ID（默认当前）' },
            },
            required: ['task_id'],
          },
        },
      },
      async (args, toolCtx) => {
        const agentId = typeof args.agent_id === 'string' && args.agent_id ? args.agent_id : toolCtx.agentId;
        return stopTask(ctx, String(args.task_id), agentId);
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_delete_watch_task',
          description: '永久删除监控任务（历史日志保留）',
          parameters: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: '任务 ID' },
              agent_id: { type: 'string', description: 'Agent ID（默认当前）' },
            },
            required: ['task_id'],
          },
        },
      },
      async (args, toolCtx) => {
        const agentId = typeof args.agent_id === 'string' && args.agent_id ? args.agent_id : toolCtx.agentId;
        return deleteTask(ctx, String(args.task_id), agentId);
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_get_report',
          description: '获取指定日期的监控报告，默认获取今日报告',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: '日期（YYYY-MM-DD 格式，默认今天）' },
            },
            required: [],
          },
        },
      },
      async (args) => {
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)
          ? args.date
          : formatDay(new Date());
        return getReportByDate(ctx, date);
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_trigger_analysis',
          description: '手动触发一次 Agent 分析（分析当日累积的增量数据）',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      async () => {
        await runAgentAnalysis(ctx);
        return '已触发 Agent 分析，结果将追加到当日报告中';
      },
    );

    ctx.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_generate_daily_report',
          description: '手动生成并推送每日汇总报告',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      async () => {
        await generateDailyReport(ctx);
        return `已生成每日报告: ${dailyReportFile(ctx, formatDay(new Date()))}`;
      },
    );

    // ── 恢复已有任务 ──
    await restoreTasks(ctx);

    // ── 启动定期 Agent 分析 ──
    _agentAnalysisTimer = setInterval(() => {
      runAgentAnalysis(ctx).catch(err => {
        console.error(`[${PLUGIN_NAME}] 定期分析出错:`, err);
      });
    }, AGENT_ANALYSIS_INTERVAL_MS);

    // ── 每日 05:40 汇总报告推送 ──
    _dailyCronTask = cron.schedule('40 5 * * *', () => {
      generateDailyReport(ctx).catch(err => {
        console.error(`[${PLUGIN_NAME}] 每日报告生成失败:`, err);
      });
    });

    console.log(`[${PLUGIN_NAME}] 已加载 ${ACTIVE_TASKS.size} 个监控任务 | Agent分析间隔: ${AGENT_ANALYSIS_INTERVAL_MS / 3600000}h | 日报推送: 05:40`);
  },
};
