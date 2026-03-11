import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as parcelWatcher from '@parcel/watcher';

const execFileAsync = promisify(execFile);

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

interface ChangeRecord {
  taskId: string;
  agentId: string;
  watchPath: string;
  timestamp: string;
  day: string;
  eventCount: number;
  counts: Record<ChangeType, number>;
  summary: string;
  kind: string;
  samples: string[];
}

const PLUGIN_NAME = 'file-watchdog';
const TASKS_FILE_NAME = 'tasks.json';
const BULK_THRESHOLD = 60;
const SAMPLE_LIMIT = 24;
const ACTIVE_TASKS = new Map<string, WatchRuntime>();

function pluginRoot(context: PluginContext): string {
  return path.join(context.workspaceDir, 'plugins', PLUGIN_NAME);
}

function dataRoot(context: PluginContext): string {
  return path.join(pluginRoot(context), 'data');
}

function snapshotsRoot(context: PluginContext): string {
  return path.join(dataRoot(context), 'snapshots');
}

function tasksFile(context: PluginContext): string {
  return path.join(dataRoot(context), TASKS_FILE_NAME);
}

function userLogDir(context: PluginContext): string {
  return path.join(context.workspaceDir, 'logs', 'watchdog');
}

function taskSnapshotFile(context: PluginContext, taskId: string): string {
  return path.join(snapshotsRoot(context), `${taskId}.snapshot`);
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizePath(inputPath: string): string {
  return path.resolve(inputPath);
}

function relativeToWatchRoot(rootPath: string, filePath: string): string {
  const relative = path.relative(rootPath, filePath);
  return relative || path.basename(filePath);
}

function sanitizeId(source: string): string {
  return source.replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTasks(context: PluginContext): Promise<WatchTask[]> {
  try {
    const content = await fs.readFile(tasksFile(context), 'utf-8');
    const parsed = JSON.parse(content) as WatchTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveTasks(context: PluginContext, tasks: WatchTask[]): Promise<void> {
  await ensureDir(dataRoot(context));
  await fs.writeFile(tasksFile(context), JSON.stringify(tasks, null, 2), 'utf-8');
}

function formatDateTime(input?: string): string {
  if (!input) return '未执行';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return `${formatDay(date)} ${formatTime(date)}`;
}

function taskStatus(task: WatchTask): string {
  if (!task.enabled) return '已停止';
  if (ACTIVE_TASKS.has(task.id)) return '运行中';
  return '待恢复';
}

function taskMatchesScope(task: WatchTask, agentId?: string): boolean {
  return !agentId || task.agentId === agentId;
}

function formatTaskSummary(task: WatchTask): string {
  return [
    `- ${task.id}`,
    `  状态：${taskStatus(task)}`,
    `  Agent：${task.agentId}`,
    `  目录：${task.watchPath}`,
    `  周期：${Math.floor(task.intervalMs / 60000)} 分钟`,
    `  创建时间：${formatDateTime(task.createdAt)}`,
    `  上次执行：${formatDateTime(task.lastRunAt)}`,
    `  备注：${task.description || '无'}`,
  ].join('\n');
}

function buildCounts(events: WatchEventLike[]): Record<ChangeType, number> {
  const counts: Record<ChangeType, number> = { create: 0, update: 0, delete: 0 };
  for (const event of events) {
    counts[event.type] += 1;
  }
  return counts;
}

function topBuckets(rootPath: string, events: WatchEventLike[]): string[] {
  const buckets = new Map<string, number>();
  for (const event of events) {
    const relative = relativeToWatchRoot(rootPath, event.path);
    const parts = relative.split(path.sep).filter(Boolean);
    const key = parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] || '.');
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([bucket, count]) => `${bucket}(${count})`);
}

function limitText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function sampleEvents(rootPath: string, events: WatchEventLike[], limit = 8): string[] {
  return events.slice(0, limit).map((event) => {
    const label = event.type === 'create'
      ? '新增'
      : event.type === 'delete'
        ? '删除'
        : '更新';
    return `${label} ${relativeToWatchRoot(rootPath, event.path)}`;
  });
}

function buildTaskHint(task: WatchTask): string {
  return task.description ? `任务备注：${task.description}` : '任务备注：无';
}

function buildLLMConfig(agent?: AgentLike): Record<string, unknown> | undefined {
  if (!agent) return undefined;
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

function buildSummarySystemPrompt(agent?: AgentLike): string {
  if (agent?.config.systemPrompt) {
    return `${agent.config.systemPrompt}\n\n你当前负责整理文件监控日志。输出务必客观、精炼、面向工作记录。`;
  }
  return '你是一个负责整理文件监控日志的智能体。输出务必客观、精炼、面向工作记录。';
}

function isPathInside(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isInternalGeneratedPath(context: PluginContext, eventPath: string): boolean {
  const absolutePath = normalizePath(eventPath);
  const pluginDataPath = dataRoot(context);
  const userLogsPath = userLogDir(context);
  const agentsPath = path.join(context.workspaceDir, 'agents');

  if (isPathInside(absolutePath, pluginDataPath)) return true;
  if (isPathInside(absolutePath, userLogsPath)) return true;
  if (isPathInside(absolutePath, agentsPath)) {
    return absolutePath.includes(`${path.sep}watchdog${path.sep}`);
  }
  return false;
}

async function ensureSnapshot(context: PluginContext, task: WatchTask): Promise<void> {
  await ensureDir(snapshotsRoot(context));
  const snapshotFile = taskSnapshotFile(context, task.id);
  if (!(await fileExists(snapshotFile))) {
    await parcelWatcher.writeSnapshot(task.watchPath, snapshotFile);
  }
}

async function gitRootForDirectory(directory: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
    const resolved = result.stdout.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

async function summarizeGitOperation(directory: string, events: WatchEventLike[]): Promise<string | null> {
  const repoRoot = await gitRootForDirectory(directory);
  if (!repoRoot) return null;

  const gitEvents = events
    .map((event) => ({ event, relative: path.relative(repoRoot, event.path) }))
    .filter((item) => item.relative.startsWith('.git' + path.sep) || item.relative === '.git');

  if (gitEvents.length === 0) return null;

  const branchCreates = new Set<string>();
  const branchDeletes = new Set<string>();
  let headChanged = false;
  let commitLike = false;

  for (const item of gitEvents) {
    const gitPath = item.relative;
    if (gitPath === path.join('.git', 'HEAD') || gitPath === path.join('.git', 'logs', 'HEAD')) {
      headChanged = true;
    }
    if (gitPath.startsWith(path.join('.git', 'objects')) || gitPath.startsWith(path.join('.git', 'logs', 'refs'))) {
      commitLike = true;
    }
    if (gitPath.startsWith(path.join('.git', 'refs', 'heads'))) {
      const branchName = gitPath.slice(path.join('.git', 'refs', 'heads').length + 1);
      const event = item.event;
      if (branchName) {
        if (event?.type === 'create') branchCreates.add(branchName);
        if (event?.type === 'delete') branchDeletes.add(branchName);
      }
    }
  }

  let branch = '';
  let lastCommit = '';
  try {
    const branchResult = await execFileAsync('git', ['-C', repoRoot, 'branch', '--show-current']);
    branch = branchResult.stdout.trim();
  } catch {
    branch = '';
  }
  try {
    const commitResult = await execFileAsync('git', ['-C', repoRoot, 'log', '-1', '--pretty=format:%h %s']);
    lastCommit = commitResult.stdout.trim();
  } catch {
    lastCommit = '';
  }

  if (branchCreates.size > 0 || branchDeletes.size > 0) {
    const changes: string[] = [];
    if (branchCreates.size > 0) changes.push(`新建分支 ${Array.from(branchCreates).join(', ')}`);
    if (branchDeletes.size > 0) changes.push(`删除分支 ${Array.from(branchDeletes).join(', ')}`);
    const current = branch ? `当前分支 ${branch}` : '当前分支未知';
    return `检测到 Git 分支变更：${changes.join('；')}。${current}。`;
  }
  if (headChanged && branch) {
    return `检测到 Git 分支切换或引用更新，当前分支为 ${branch}${lastCommit ? `，最新提交 ${lastCommit}` : ''}。`;
  }
  if (commitLike) {
    return `检测到 Git 提交或引用更新${branch ? `，当前分支 ${branch}` : ''}${lastCommit ? `，最新提交 ${lastCommit}` : ''}。`;
  }
  return `检测到 Git 元数据批量变化${branch ? `，当前分支 ${branch}` : ''}${lastCommit ? `，最新提交 ${lastCommit}` : ''}。`;
}

async function summarizeBulkOperation(task: WatchTask, events: WatchEventLike[]): Promise<{ kind: string; summary: string } | null> {
  const relativePaths = events.map((event) => relativeToWatchRoot(task.watchPath, event.path));
  const nodeModulesChanges = relativePaths.filter((item) => item === 'node_modules' || item.startsWith(`node_modules${path.sep}`));
  if (nodeModulesChanges.length >= 30 || nodeModulesChanges.length / Math.max(events.length, 1) >= 0.65) {
    return {
      kind: 'bulk_dependency_update',
      summary: `检测到 node_modules 下的大规模常规变更，推测执行了依赖安装或更新命令（如 npm install、pnpm install）。`,
    };
  }

  const gitSummary = await summarizeGitOperation(task.watchPath, events);
  if (gitSummary) {
    return { kind: 'bulk_git_operation', summary: gitSummary };
  }

  const generatedDirs = ['dist', 'build', '.next', 'coverage', '.turbo'];
  const generatedCount = relativePaths.filter((item) => generatedDirs.some((prefix) => item === prefix || item.startsWith(`${prefix}${path.sep}`))).length;
  if (generatedCount >= 30 || generatedCount / Math.max(events.length, 1) >= 0.6) {
    return {
      kind: 'bulk_generated_artifacts',
      summary: `检测到构建产物或缓存目录的大规模变化，主要属于常规生成文件更新。`,
    };
  }

  if (events.length >= BULK_THRESHOLD) {
    const buckets = topBuckets(task.watchPath, events);
    return {
      kind: 'bulk_generic_change',
      summary: `检测到 ${events.length} 个文件的批量变化，主要集中在 ${buckets.join('、')}，已按常规批量操作做概括记录。`,
    };
  }

  return null;
}

async function summarizeBatch(
  context: PluginContext,
  task: WatchTask,
  agent: AgentLike | undefined,
  events: WatchEventLike[],
): Promise<{ kind: string; summary: string }> {
  const bulkSummary = await summarizeBulkOperation(task, events);
  if (bulkSummary) return bulkSummary;

  const counts = buildCounts(events);
  const buckets = topBuckets(task.watchPath, events);
  const samples = sampleEvents(task.watchPath, events, 12);
  const prompt = [
    '请把下面一次目录监控结果整理成一段中文工作记录。',
    '要求：',
    '1. 输出 50 到 120 字。',
    '2. 只做概要，不要逐文件罗列。',
    '3. 强调主要目录、主要动作和变化性质。',
    '4. 如果看起来像常规维护操作，也只需要简要概括。',
    '',
    `监控目录：${task.watchPath}`,
    buildTaskHint(task),
    `变化统计：新增 ${counts.create}，更新 ${counts.update}，删除 ${counts.delete}。`,
    `主要目录：${buckets.join('、') || '无明显集中目录'}。`,
    '变化样例：',
    ...samples.map((item) => `- ${item}`),
  ].join('\n');

  try {
    const response = await context.quickAsk(
      prompt,
      buildSummarySystemPrompt(agent),
      buildLLMConfig(agent)
    );
    const summary = limitText(response.trim().replace(/\s+/g, ' '), 180);
    if (summary) {
      return { kind: 'llm_summary', summary };
    }
  } catch {
    // 回退到规则摘要
  }

  const fallbackBuckets = buckets.length > 0 ? `，主要集中在 ${buckets.join('、')}` : '';
  return {
    kind: 'rule_summary',
    summary: `检测到目录内容发生变化：新增 ${counts.create}、更新 ${counts.update}、删除 ${counts.delete}${fallbackBuckets}。`,
  };
}

function recordPaths(agent: AgentLike, day: string): { raw: string; timeline: string; report: string } {
  const watchdogRoot = path.join(agent.workspaceDir, 'watchdog');
  return {
    raw: path.join(watchdogRoot, 'raw', `${day}.jsonl`),
    timeline: path.join(watchdogRoot, 'records', `${day}.md`),
    report: path.join(watchdogRoot, 'reports', `${day}.md`),
  };
}

async function appendRecord(agent: AgentLike, record: ChangeRecord): Promise<void> {
  const paths = recordPaths(agent, record.day);
  await ensureDir(path.dirname(paths.raw));
  await ensureDir(path.dirname(paths.timeline));
  await fs.appendFile(paths.raw, `${JSON.stringify(record)}\n`, 'utf-8');

  const lines = [
    `## ${formatTime(new Date(record.timestamp))} | ${record.taskId}`,
    '',
    `- 监控目录：${record.watchPath}`,
    `- 事件数量：${record.eventCount}`,
    `- 变化统计：新增 ${record.counts.create} / 更新 ${record.counts.update} / 删除 ${record.counts.delete}`,
    `- 摘要：${record.summary}`,
  ];
  if (record.samples.length > 0) {
    lines.push(`- 样例：${record.samples.join('；')}`);
  }
  lines.push('', '');
  await fs.appendFile(paths.timeline, `${lines.join('\n')}`, 'utf-8');
}

async function readJsonLines(filePath: string): Promise<ChangeRecord[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChangeRecord);
  } catch {
    return [];
  }
}

function fallbackDailyReport(agent: AgentLike, day: string, records: ChangeRecord[]): string {
  const totalEvents = records.reduce((sum, record) => sum + record.eventCount, 0);
  const highlights = records.slice(-10).map((record) => `- ${formatTime(new Date(record.timestamp))} ${record.summary}`);
  return [
    `# ${agent.name} 文件监控日报`,
    '',
    `日期：${day}`,
    `记录批次：${records.length}`,
    `累计变化：${totalEvents}`,
    '',
    '## 今日概览',
    '',
    `今日共记录 ${records.length} 次目录变化，累计涉及 ${totalEvents} 个文件事件。`,
    '',
    '## 重点变化',
    '',
    ...highlights,
    '',
  ].join('\n');
}

async function refreshAgentDailyReport(context: PluginContext, agent: AgentLike, day: string): Promise<void> {
  const paths = recordPaths(agent, day);
  const records = await readJsonLines(paths.raw);
  if (records.length === 0) return;

  const recentLines = records.slice(-18).map((record) => `- ${formatTime(new Date(record.timestamp))} ${record.summary}`);
  const prompt = [
    `请根据下面的目录监控记录，为 ${agent.name} 生成一份当天的工作报告。`,
    '要求：',
    '1. 使用 Markdown。',
    '2. 包含「今日概览」「重点变化」「常规批量操作」三个小节。',
    '3. 对 npm install、git 切换、构建产物刷新等常规大规模操作只做简要概括。',
    '4. 不编造没有出现的信息。',
    '5. 控制在 220 到 420 字。',
    '',
    `日期：${day}`,
    `记录批次：${records.length}`,
    `累计文件事件：${records.reduce((sum, record) => sum + record.eventCount, 0)}`,
    '',
    '监控摘要：',
    ...recentLines,
  ].join('\n');

  let report = '';
  try {
    report = await context.quickAsk(
      prompt,
      buildSummarySystemPrompt(agent),
      buildLLMConfig(agent)
    );
  } catch {
    report = fallbackDailyReport(agent, day, records);
  }

  const finalReport = report.trim() || fallbackDailyReport(agent, day, records);
  await ensureDir(path.dirname(paths.report));
  await fs.writeFile(paths.report, `${finalReport}\n`, 'utf-8');
}

async function refreshGlobalDailyLog(context: PluginContext, day: string): Promise<void> {
  const sections: string[] = [
    `# Watchdog 汇总日志`,
    '',
    `日期：${day}`,
    `更新时间：${new Date().toISOString()}`,
    '',
  ];

  for (const agent of context.systemManager.agents.values()) {
    const reportPath = recordPaths(agent, day).report;
    if (!(await fileExists(reportPath))) continue;
    const report = (await fs.readFile(reportPath, 'utf-8')).trim();
    if (!report) continue;
    sections.push(`## ${agent.name} (${agent.id})`, '', report, '');
  }

  if (sections.length <= 5) return;
  await ensureDir(userLogDir(context));
  await fs.writeFile(path.join(userLogDir(context), `${day}.md`), `${sections.join('\n')}\n`, 'utf-8');
}

async function buildChangeRecord(
  context: PluginContext,
  task: WatchTask,
  agent: AgentLike | undefined,
  events: WatchEventLike[],
): Promise<ChangeRecord> {
  const now = new Date();
  const counts = buildCounts(events);
  const summaryPayload = await summarizeBatch(context, task, agent, events);
  return {
    taskId: task.id,
    agentId: task.agentId,
    watchPath: task.watchPath,
    timestamp: now.toISOString(),
    day: formatDay(now),
    eventCount: events.length,
    counts,
    summary: summaryPayload.summary,
    kind: summaryPayload.kind,
    samples: sampleEvents(task.watchPath, events, 6),
  };
}

async function runTask(context: PluginContext, taskId: string): Promise<ChangeRecord | null> {
  const runtime = ACTIVE_TASKS.get(taskId);
  if (!runtime || runtime.running || !runtime.task.enabled) return null;

  runtime.running = true;
  try {
    const task = runtime.task;
    await ensureSnapshot(context, task);

    const snapshotFile = taskSnapshotFile(context, task.id);
    const rawEvents = await parcelWatcher.getEventsSince(task.watchPath, snapshotFile);
    await parcelWatcher.writeSnapshot(task.watchPath, snapshotFile);

    const events = (rawEvents as WatchEventLike[])
      .map((event) => ({ type: event.type, path: normalizePath(event.path) }))
      .filter((event) => !isInternalGeneratedPath(context, event.path));

    task.lastRunAt = new Date().toISOString();
    const tasks = await readTasks(context);
    const taskIndex = tasks.findIndex((item) => item.id === task.id);
    if (taskIndex >= 0) {
      tasks[taskIndex] = task;
      await saveTasks(context, tasks);
    }

    if (events.length === 0) return null;

    const agent = context.systemManager.agents.get(task.agentId);
    if (!agent) return null;

    const record = await buildChangeRecord(context, task, agent, events);
    await appendRecord(agent, record);
    await refreshAgentDailyReport(context, agent, record.day);
    await refreshGlobalDailyLog(context, record.day);
    return record;
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] 任务 ${taskId} 执行失败:`, error);
    return null;
  } finally {
    runtime.running = false;
  }
}

async function startTask(context: PluginContext, task: WatchTask): Promise<void> {
  const existing = ACTIVE_TASKS.get(task.id);
  if (existing) {
    clearInterval(existing.timer);
    ACTIVE_TASKS.delete(task.id);
  }

  await ensureSnapshot(context, task);
  const timer = setInterval(() => {
    runTask(context, task.id).catch((error) => {
      console.error(`[${PLUGIN_NAME}] 定时任务 ${task.id} 执行失败:`, error);
    });
  }, task.intervalMs);

  ACTIVE_TASKS.set(task.id, { task, timer, running: false });
}

async function stopTask(context: PluginContext, taskId: string, agentId?: string): Promise<string> {
  const tasks = await readTasks(context);
  const task = tasks.find((item) => item.id === taskId && taskMatchesScope(item, agentId));
  if (!task) {
    return `未找到监控任务: ${taskId}`;
  }

  task.enabled = false;
  const runtime = ACTIVE_TASKS.get(task.id);
  if (runtime) {
    clearInterval(runtime.timer);
    ACTIVE_TASKS.delete(task.id);
  }

  await saveTasks(context, tasks);
  return [
    `已停止监控任务：${task.id}`,
    `目录：${task.watchPath}`,
    `Agent：${task.agentId}`,
  ].join('\n');
}

async function deleteTask(context: PluginContext, taskId: string, agentId?: string): Promise<string> {
  const tasks = await readTasks(context);
  const taskIndex = tasks.findIndex((item) => item.id === taskId && taskMatchesScope(item, agentId));
  if (taskIndex < 0) {
    return `未找到监控任务: ${taskId}`;
  }

  const [task] = tasks.splice(taskIndex, 1);
  const runtime = ACTIVE_TASKS.get(task.id);
  if (runtime) {
    clearInterval(runtime.timer);
    ACTIVE_TASKS.delete(task.id);
  }

  const snapshotFile = taskSnapshotFile(context, task.id);
  await fs.rm(snapshotFile, { force: true }).catch(() => undefined);
  await saveTasks(context, tasks);

  return [
    `已删除监控任务：${task.id}`,
    `目录：${task.watchPath}`,
    `Agent：${task.agentId}`,
    `快照：${snapshotFile}`,
    '历史日志已保留。',
  ].join('\n');
}

async function runTaskOnce(context: PluginContext, taskId: string, agentId?: string): Promise<string> {
  const tasks = await readTasks(context);
  const task = tasks.find((item) => item.id === taskId && taskMatchesScope(item, agentId));
  if (!task) {
    return `未找到监控任务: ${taskId}`;
  }
  if (!task.enabled) {
    return `监控任务 ${task.id} 当前已停止，请先恢复后再执行。`;
  }

  if (!ACTIVE_TASKS.has(task.id)) {
    await startTask(context, task);
  }

  const record = await runTask(context, task.id);
  if (!record) {
    return [
      `已执行监控任务：${task.id}`,
      `目录：${task.watchPath}`,
      '结果：本次未检测到新的文件变化。',
    ].join('\n');
  }

  return [
    `已立即执行监控任务：${task.id}`,
    `目录：${task.watchPath}`,
    `时间：${formatDateTime(record.timestamp)}`,
    `事件数：${record.eventCount}`,
    `摘要：${record.summary}`,
  ].join('\n');
}

async function listTasks(context: PluginContext, agentId?: string, includeStopped = true): Promise<string> {
  const tasks = await readTasks(context);
  const filtered = tasks.filter((task) => taskMatchesScope(task, agentId) && (includeStopped || task.enabled));
  if (filtered.length === 0) {
    return agentId
      ? `Agent ${agentId} 当前没有匹配的 watchdog 任务。`
      : '当前没有任何 watchdog 任务。';
  }

  const lines = filtered
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((task) => formatTaskSummary(task));

  return [
    `Watchdog 任务总数：${filtered.length}`,
    '',
    ...lines,
  ].join('\n');
}

async function restoreTasks(context: PluginContext): Promise<void> {
  const tasks = await readTasks(context);
  for (const task of tasks) {
    if (!task.enabled) continue;
    try {
      await startTask(context, task);
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] 恢复任务 ${task.id} 失败:`, error);
    }
  }
}

async function createWatchTask(
  context: PluginContext,
  agentId: string,
  watchPathInput: string,
  intervalMinutes: number,
  description?: string,
): Promise<string> {
  const watchPath = normalizePath(watchPathInput);
  const stat = await fs.stat(watchPath).catch(() => null);
  if (!stat?.isDirectory()) {
    return `无法创建监控任务：目录不存在或不可访问 -> ${watchPath}`;
  }

  const intervalMs = Math.max(1, Math.floor(intervalMinutes)) * 60 * 1000;
  const tasks = await readTasks(context);
  const existing = tasks.find(
    (task) => task.agentId === agentId && task.watchPath === watchPath && task.intervalMs === intervalMs && task.enabled
  );

  if (existing) {
    await startTask(context, existing);
    return `监控任务已存在：${existing.id}\n目录：${existing.watchPath}\n周期：${Math.floor(existing.intervalMs / 60000)} 分钟`;
  }

  const stopped = tasks.find(
    (task) => task.agentId === agentId && task.watchPath === watchPath && task.intervalMs === intervalMs && !task.enabled
  );
  if (stopped) {
    stopped.enabled = true;
    stopped.description = description?.trim() || stopped.description;
    await saveTasks(context, tasks);
    await startTask(context, stopped);
    return [
      `已恢复 watchdog 监控任务：${stopped.id}`,
      `目录：${stopped.watchPath}`,
      `周期：${Math.floor(stopped.intervalMs / 60000)} 分钟`,
      buildTaskHint(stopped),
    ].join('\n');
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
  await saveTasks(context, tasks);
  await startTask(context, task);

  return [
    `已创建 watchdog 监控任务：${task.id}`,
    `目录：${task.watchPath}`,
    `周期：${Math.floor(task.intervalMs / 60000)} 分钟`,
    buildTaskHint(task),
    `记录目录：${path.join(context.workspaceDir, 'agents', agentId, 'watchdog')}`,
    `汇总日志：${path.join(userLogDir(context), `${formatDay(new Date())}.md`)}`,
  ].join('\n');
}

export default {
  name: PLUGIN_NAME,
  async install(context: PluginContext): Promise<void> {
    await ensureDir(dataRoot(context));
    await ensureDir(snapshotsRoot(context));
    await ensureDir(userLogDir(context));

    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_create_watch_task',
          description: '创建一个目录 watchdog 监控任务，按固定时间间隔检查变化并将摘要记录到当前 Agent 的工作目录与工作区日志中。',
          parameters: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: '要监控的目录绝对路径或相对路径。',
              },
              interval_minutes: {
                type: 'number',
                description: '监控周期，单位分钟。',
              },
              description: {
                type: 'string',
                description: '该监控任务的用途说明，可选。',
              },
            },
            required: ['directory', 'interval_minutes'],
          },
        },
      },
      async (args, toolContext) => {
        const targetDirectory = path.isAbsolute(args.directory as string)
          ? (args.directory as string)
          : path.resolve(context.workspaceDir, args.directory as string);
        return await createWatchTask(
          context,
          toolContext.agentId,
          targetDirectory,
          Number(args.interval_minutes),
          typeof args.description === 'string' ? args.description : undefined,
        );
      }
    );

    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_list_watch_tasks',
          description: '列出当前 Agent 或指定 Agent 的 watchdog 监控任务，支持包含或排除已停止任务。',
          parameters: {
            type: 'object',
            properties: {
              agent_id: {
                type: 'string',
                description: '要查看的 Agent ID，默认当前 Agent。',
              },
              include_stopped: {
                type: 'boolean',
                description: '是否包含已停止任务，默认 true。',
              },
            },
            required: [],
          },
        },
      },
      async (args, toolContext) => {
        const targetAgentId = typeof args.agent_id === 'string' && args.agent_id
          ? args.agent_id
          : toolContext.agentId;
        const includeStopped = typeof args.include_stopped === 'boolean'
          ? args.include_stopped
          : true;
        return await listTasks(context, targetAgentId, includeStopped);
      }
    );

    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_run_watch_task_once',
          description: '立即执行一次已有的 watchdog 监控任务，不等待下一个定时周期，并返回本次摘要结果。',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: '要立即执行的监控任务 ID。',
              },
              agent_id: {
                type: 'string',
                description: '任务所属 Agent ID，默认当前 Agent。',
              },
            },
            required: ['task_id'],
          },
        },
      },
      async (args, toolContext) => {
        const targetAgentId = typeof args.agent_id === 'string' && args.agent_id
          ? args.agent_id
          : toolContext.agentId;
        return await runTaskOnce(context, String(args.task_id), targetAgentId);
      }
    );

    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_stop_watch_task',
          description: '停止一个已有的 watchdog 监控任务。停止后任务会保留，可通过再次创建相同配置恢复。',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: '要停止的监控任务 ID。',
              },
              agent_id: {
                type: 'string',
                description: '任务所属 Agent ID，默认当前 Agent。',
              },
            },
            required: ['task_id'],
          },
        },
      },
      async (args, toolContext) => {
        const targetAgentId = typeof args.agent_id === 'string' && args.agent_id
          ? args.agent_id
          : toolContext.agentId;
        return await stopTask(context, String(args.task_id), targetAgentId);
      }
    );

    context.registerTool(
      {
        type: 'function',
        function: {
          name: 'watchdog_delete_watch_task',
          description: '永久删除一个 watchdog 监控任务，并清理其快照文件。历史日志会保留。',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: '要删除的监控任务 ID。',
              },
              agent_id: {
                type: 'string',
                description: '任务所属 Agent ID，默认当前 Agent。',
              },
            },
            required: ['task_id'],
          },
        },
      },
      async (args, toolContext) => {
        const targetAgentId = typeof args.agent_id === 'string' && args.agent_id
          ? args.agent_id
          : toolContext.agentId;
        return await deleteTask(context, String(args.task_id), targetAgentId);
      }
    );

    await restoreTasks(context);
    console.log(`[${PLUGIN_NAME}] 已加载 ${ACTIVE_TASKS.size} 个监控任务`);
  },
};