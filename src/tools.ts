/**
 * 工具系统 — midou 与世界交互的能力
 *
 * 使用纯 JSON 工具定义 + handler 函数，无需任何第三方 Tool 基类。
 * 支持动态注册插件工具、MCP 工具。
 */

import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { isMCPTool, executeMCPTool } from './mcp.js';
import { listSkillNames, loadSkillContent } from './skills.js';
import { memoryManager } from './memory.js';
import {
  addTodoItem,
  updateTodoStatus,
  getTodoItems,
} from './todo.js';
import { createArtifact, collectArtifactsByType, listStageArtifacts } from './artifact.js';
import { parseContractsFromDir } from './contract.js';
import dayjs from 'dayjs';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  ToolDefinition,
  ToolHandler,
  SystemManagerInterface,
  ArtifactType,
  AgentRole,
} from './types.js';

// ── ToolHalt：中断工具循环的特殊返回 ──

export class ToolHalt {
  content: string;
  constructor(content: string) {
    this.content = content;
  }
}

// ── 工具注册项（定义 + handler） ──

export interface ToolEntry {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<string | ToolHalt>;
}

// ── 动态工具注册表 ──

export const dynamicToolHandlers = new Map<string, ToolHandler>();
export let toolDefinitions: ToolDefinition[] = [];

export function registerTool(definition: ToolDefinition, handler: ToolHandler): void {
  const existingIndex = toolDefinitions.findIndex(
    (t) => t.function.name === definition.function.name
  );
  if (existingIndex >= 0) {
    toolDefinitions[existingIndex] = definition;
  } else {
    toolDefinitions.push(definition);
  }
  dynamicToolHandlers.set(definition.function.name, handler);
}

// ═══════════════════════════════════════════
// 工具执行上下文
// ═══════════════════════════════════════════

export interface ToolContext {
  systemManager: SystemManagerInterface | null;
  agentId: string;
}

// ═══════════════════════════════════════════
// 定义核心工具
// ═══════════════════════════════════════════

/**
 * 定义工具的辅助函数——简化 JSON schema 书写
 */
function defineTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<string | ToolHalt>,
): ToolEntry {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          ...parameters,
        },
      },
    },
    handler,
  };
}

/**
 * 创建所有核心工具
 */
export function createCoreTools(ctx: ToolContext): ToolEntry[] {
  const tools: ToolEntry[] = [];

  // ── finish_task ──
  tools.push(defineTool(
    'finish_task',
    '当任务彻底完成时调用此工具，结束当前任务循环。',
    {
      properties: { summary: { type: 'string', description: '任务完成的总结说明' } },
      required: ['summary'],
    },
    async (args) => new ToolHalt(`任务已完成: ${args.summary}`),
  ));

  // ── ask_user ──
  tools.push(defineTool(
    'ask_user',
    '向用户提出问题，等待用户回复。当你需要用户的输入或确认时使用此工具。',
    {
      properties: { question: { type: 'string', description: '要问用户的问题' } },
      required: ['question'],
    },
    async (args) => new ToolHalt(`[等待用户回复] ${args.question}`),
  ));

  // ── search_memory ──
  tools.push(defineTool(
    'search_memory',
    '搜索长期记忆，获取历史对话中总结的重要事实、用户偏好或未完成的任务。',
    {
      properties: {
        query: { type: 'string', description: '搜索关键词或自然语言问题' },
        limit: { type: 'number', description: '返回的记忆条数（默认 5）' },
      },
      required: ['query'],
    },
    async (args) => {
      try {
        const results = await memoryManager.searchMemory(ctx.agentId, args.query as string, (args.limit as number) || 5);
        if (!results || results.length === 0) return `未找到与 "${args.query}" 相关的记忆。`;
        return results
          .map((r, i) => {
            const weight = (r.attentionWeight * 100).toFixed(1) + '%';
            const rel = r.metrics.isRelational ? ' [关联推理]' : '';
            return `[记忆 ${i + 1}] (注意力权重: ${weight}${rel} | 类型: ${r.type}):\n${r.content}`;
          })
          .join('\n\n');
      } catch (e: unknown) {
        return `搜索记忆失败: ${(e as Error).message}`;
      }
    },
  ));

  // ── add_memory ──
  tools.push(defineTool(
    'add_memory',
    '将重要信息、事实或总结存入长期记忆库中。',
    {
      properties: {
        content: { type: 'string', description: '要记忆的内容' },
        importance: { type: 'number', description: '重要性评分 (1-5，5最重要，默认 3)' },
        type: { type: 'string', enum: ['semantic', 'episodic'], description: '记忆类型' },
      },
      required: ['content'],
    },
    async (args) => {
      try {
        const id = await memoryManager.addMemory(
          ctx.agentId,
          args.content as string,
          (args.type as string) || 'semantic',
          (args.importance as number) || 3,
        );
        return `已成功将内容存入记忆库 (ID: ${id}, 类型: ${args.type || 'semantic'})。`;
      } catch (e: unknown) {
        return `添加记忆失败: ${(e as Error).message}`;
      }
    },
  ));

  // ── read_agent_log ──
  tools.push(defineTool(
    'read_agent_log',
    '读取指定 Agent 在某天的对话日志。',
    {
      properties: {
        agent_name: { type: 'string', description: 'Agent 的名称' },
        days_ago: { type: 'number', description: '读取几天前的日志' },
      },
      required: ['agent_name', 'days_ago'],
    },
    async (args) => {
      const date = dayjs().subtract(args.days_ago as number, 'day').format('YYYY-MM-DD');
      const logPath = `agents/${args.agent_name}/memory/${date}.md`;
      try {
        const content = await fs.readFile(path.join(MIDOU_WORKSPACE_DIR, logPath), 'utf-8');
        return content || `Agent ${args.agent_name} 在 ${date} 没有日志记录。`;
      } catch {
        return `无法读取 Agent ${args.agent_name} 在 ${date} 的日志。`;
      }
    },
  ));

  // ── read_organization_roster ──
  tools.push(defineTool(
    'read_organization_roster',
    '读取组织花名册，了解组织里有哪些 Agent。',
    { properties: {} },
    async () => {
      if (ctx.systemManager) {
        return ctx.systemManager.getOrganizationRoster(ctx.agentId);
      }
      return '组织花名册功能尚未初始化。';
    },
  ));

  // ── send_message ──
  tools.push(defineTool(
    'send_message',
    '通过消息总线向其他成员发送消息。',
    {
      properties: {
        target_agent_id: { type: 'string', description: '目标成员的 ID' },
        message: { type: 'string', description: '要发送的消息内容' },
        from: { type: 'string', description: '发送者名称（你的名字），让接收方知道消息来自谁' },
      },
      required: ['target_agent_id', 'message', 'from'],
    },
    async (args) => {
      if (ctx.systemManager) {
        const from = (args.from as string) || ctx.agentId;
        const msgWithSender = `[来自 ${from}]: ${args.message as string}`;
        return await ctx.systemManager.sendMessage(ctx.agentId, args.target_agent_id as string, msgWithSender);
      }
      return '消息总线功能尚未初始化。';
    },
  ));

  // ── create_agent ──
  tools.push(defineTool(
    'create_agent',
    '创建一个智能体来帮你完成特定任务。',
    {
      properties: {
        name: { type: 'string', description: '智能体的名称' },
        system_prompt: { type: 'string', description: '智能体的系统提示词' },
        task: { type: 'string', description: '分配给智能体的具体任务描述' },
      },
      required: ['task'],
    },
    async (args) => {
      if (ctx.systemManager) {
        return await ctx.systemManager.createChildAgent(ctx.agentId, {
          name: args.name as string | undefined,
          systemPrompt: args.system_prompt as string | undefined,
          task: args.task as string,
        });
      }
      return '子 Agent 创建功能尚未初始化。';
    },
  ));

  // ── run_command ──
  tools.push(defineTool(
    'run_command',
    '在终端中执行 shell 命令。注意：危险命令会被拦截。',
    {
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 10000' },
      },
      required: ['command'],
    },
    async (args) => {
      const command = args.command as string;
      const safeCheck = isSafeCommand(command);
      if (safeCheck === 'SUDO_BLOCKED') {
        return '⚠️ 该命令需要管理员权限。请直接将命令输出给用户，让用户手动执行。';
      } else if (!safeCheck) {
        return '⚠️ 该命令被安全策略拦截。';
      }

      let workDir = args.cwd as string | undefined;
      if (!workDir && ctx.systemManager && ctx.agentId) {
        const agent = ctx.systemManager.agents.get(ctx.agentId);
        if (agent) workDir = agent.workspaceDir;
      }

      const result = await runShellCommand(command, { cwd: workDir, timeout: (args.timeout as number) || 10000 });
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
      output += `\n[exit code: ${result.exitCode}]`;
      if (output.length > 8000) {
        output = output.slice(0, 8000) + '\n... [输出已截断]';
      }
      return output;
    },
  ));

  // ── read_system_file ──
  tools.push(defineTool(
    'read_system_file',
    '读取系统中的任意文件。',
    {
      properties: {
        path: { type: 'string', description: '文件路径' },
        encoding: { type: 'string', description: '编码，默认 utf-8' },
      },
      required: ['path'],
    },
    async (args) => {
      try {
        const enc = ((args.encoding as string) || 'utf-8') as BufferEncoding;
        const content = await fs.readFile(args.path as string, enc);
        if (content.length > 10000) {
          return content.slice(0, 10000) + '\n... [内容已截断，共 ' + content.length + ' 字符]';
        }
        return content;
      } catch (err: unknown) {
        return `无法读取文件 ${args.path}: ${(err as Error).message}`;
      }
    },
  ));

  // ── write_system_file ──
  tools.push(defineTool(
    'write_system_file',
    '写入系统中的任意文件。如果目录不存在会自动创建。',
    {
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的内容' },
      },
      required: ['path', 'content'],
    },
    async (args) => {
      try {
        const filePath = args.path as string;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, args.content as string, 'utf-8');
        return `已写入 ${filePath}`;
      } catch (err: unknown) {
        return `无法写入文件 ${args.path}: ${(err as Error).message}`;
      }
    },
  ));

  // ── list_system_dir ──
  tools.push(defineTool(
    'list_system_dir',
    '列出系统中的目录内容。',
    {
      properties: {
        path: { type: 'string', description: '目录路径' },
        details: { type: 'boolean', description: '是否显示详细信息' },
      },
      required: ['path'],
    },
    async (args) => {
      const dirPath = args.path as string;
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        if (args.details) {
          const detailed: string[] = [];
          for (const e of entries) {
            try {
              const stat = await fs.stat(path.join(dirPath, e.name));
              const type = e.isDirectory() ? '📁' : '📄';
              const size = e.isDirectory() ? '-' : formatSize(stat.size);
              const mtime = stat.mtime.toISOString().slice(0, 16).replace('T', ' ');
              detailed.push(`${type} ${e.name.padEnd(30)} ${size.padStart(10)}  ${mtime}`);
            } catch {
              detailed.push(`${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
            }
          }
          return detailed.join('\n') || '（空目录）';
        }
        const lines = entries.map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
        return lines.join('\n') || '（空目录）';
      } catch (err: unknown) {
        return `无法列出目录 ${dirPath}: ${(err as Error).message}`;
      }
    },
  ));

  // ── list_skills ──
  tools.push(defineTool(
    'list_skills',
    '列出所有可用的技能。',
    { properties: {} },
    async () => {
      const skills = await listSkillNames();
      return skills.length === 0 ? '当前没有可用的技能。' : skills.join('\n');
    },
  ));

  // ── load_skill ──
  tools.push(defineTool(
    'load_skill',
    '加载某个技能的详细指令。',
    {
      properties: { skill_name: { type: 'string', description: '技能名称' } },
      required: ['skill_name'],
    },
    async (args) => {
      const content = await loadSkillContent(args.skill_name as string);
      return content || `未找到技能: ${args.skill_name}`;
    },
  ));

  // ── create_todo ──
  tools.push(defineTool(
    'create_todo',
    '创建一个新的工作任务（TODO）。',
    {
      properties: {
        title: { type: 'string', description: '任务标题' },
        description: { type: 'string', description: '任务详细描述' },
        agent_id: { type: 'string', description: '指派对象的 Agent ID 或名称' },
      },
      required: ['title'],
    },
    async (args) => {
      let targetAgentId = (args.agent_id as string) || ctx.agentId;
      if (ctx.systemManager?.agents && !ctx.systemManager.agents.has(targetAgentId)) {
        const matchedAgent = Array.from(ctx.systemManager.agents.values()).find((a) => a.name === targetAgentId);
        if (matchedAgent) targetAgentId = matchedAgent.id;
      }
      const item = await addTodoItem(targetAgentId, args.title as string, (args.description as string) || '');
      return `已创建任务 [${item.id}]: ${item.title} (指派给: ${targetAgentId})`;
    },
  ));

  // ── update_todo ──
  tools.push(defineTool(
    'update_todo',
    '更新任务状态或备注。',
    {
      properties: {
        id: { type: 'string', description: '任务 ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: '新状态' },
        notes: { type: 'string', description: '任务备注或执行结果' },
      },
      required: ['id'],
    },
    async (args) => {
      const updates: Record<string, string> = {};
      if (args.status) updates.status = args.status as string;
      if (args.notes) updates.notes = args.notes as string;
      const item = await updateTodoStatus(args.id as string, updates);
      if (!item) return `未找到任务 [${args.id}]`;
      const statusMap: Record<string, string> = {
        pending: '待办', in_progress: '进行中', done: '✓ 完成', blocked: '阻塞',
      };
      return `任务 [${item.id}] "${item.title}" 已更新。状态: ${statusMap[item.status] || item.status}`;
    },
  ));

  // ── list_todos ──
  tools.push(defineTool(
    'list_todos',
    '列出所有工作任务。',
    { properties: {} },
    async () => {
      const items = await getTodoItems(ctx.agentId);
      if (items.length === 0) return '当前没有工作任务';
      const statusIcon: Record<string, string> = {
        pending: '□', in_progress: '►', done: '✓', blocked: '✗',
      };
      return items
        .map((i) =>
          `[${i.id}] ${statusIcon[i.status] || '?'} ${i.title}${i.description ? ' — ' + i.description : ''}${i.notes ? ' (备注: ' + i.notes + ')' : ''}`
        )
        .join('\n');
    },
  ));

  // ═══════════════════════════════════════════
  // Pipeline 相关工具
  // ═══════════════════════════════════════════

  // ── produce_artifact ──
  tools.push(defineTool(
    'produce_artifact',
    '在流水线中产出一个结构化制品（如契约、代码、审查报告等）。',
    {
      properties: {
        type: { type: 'string', enum: ['contract', 'code', 'review-report', 'test-suite', 'mock-data'], description: '制品类型' },
        pipeline_run_id: { type: 'string', description: '流水线运行 ID' },
        stage_id: { type: 'string', description: '阶段 ID' },
        payload: { type: 'string', description: '制品内容（JSON 字符串或纯文本）' },
      },
      required: ['type', 'pipeline_run_id', 'stage_id', 'payload'],
    },
    async (args) => {
      try {
        let payload: unknown;
        try {
          payload = JSON.parse(args.payload as string);
        } catch {
          payload = args.payload as string;
        }
        const artifact = await createArtifact(
          args.type as ArtifactType,
          ctx.agentId,
          args.pipeline_run_id as string,
          args.stage_id as string,
          payload,
        );
        // 通知 pipeline engine
        if (ctx.systemManager?.pipelineEngine) {
          ctx.systemManager.pipelineEngine.submitArtifact(
            args.pipeline_run_id as string,
            args.stage_id as string,
            artifact,
          );
        }
        return `制品已创建: ${artifact.id} (类型: ${artifact.type})`;
      } catch (e: unknown) {
        return `产出制品失败: ${(e as Error).message}`;
      }
    },
  ));

  // ── consume_artifacts ──
  tools.push(defineTool(
    'consume_artifacts',
    '获取流水线上游阶段产出的制品列表。',
    {
      properties: {
        pipeline_run_id: { type: 'string', description: '流水线运行 ID' },
        stage_ids: { type: 'string', description: '上游阶段 ID（逗号分隔）' },
        types: { type: 'string', description: '制品类型筛选（逗号分隔，如 contract,code）' },
      },
      required: ['pipeline_run_id', 'stage_ids'],
    },
    async (args) => {
      try {
        const stageIds = (args.stage_ids as string).split(',').map(s => s.trim());
        const types = args.types
          ? (args.types as string).split(',').map(s => s.trim()) as ArtifactType[]
          : undefined;

        let artifacts;
        if (types && types.length > 0) {
          artifacts = await collectArtifactsByType(args.pipeline_run_id as string, stageIds, types);
        } else {
          const all = [];
          for (const sid of stageIds) {
            const stageArts = await listStageArtifacts(args.pipeline_run_id as string, sid);
            all.push(...stageArts);
          }
          artifacts = all;
        }

        if (artifacts.length === 0) return '未找到匹配的制品。';
        return JSON.stringify(artifacts, null, 2);
      } catch (e: unknown) {
        return `获取制品失败: ${(e as Error).message}`;
      }
    },
  ));

  // ── parse_contracts ──
  tools.push(defineTool(
    'parse_contracts',
    '扫描项目目录，解析所有 @api-contract 注解，返回结构化的 API 契约列表。',
    {
      properties: {
        project_dir: { type: 'string', description: '项目根目录路径' },
      },
      required: ['project_dir'],
    },
    async (args) => {
      try {
        const contracts = await parseContractsFromDir(args.project_dir as string);
        if (contracts.length === 0) return '未找到 @api-contract 注解。';
        return JSON.stringify(contracts, null, 2);
      } catch (e: unknown) {
        return `解析契约失败: ${(e as Error).message}`;
      }
    },
  ));

  // ── submit_verdict ──
  tools.push(defineTool(
    'submit_verdict',
    '作为审查 Agent，对流水线阶段提交裁决（通过或阻塞）。',
    {
      properties: {
        pipeline_run_id: { type: 'string', description: '流水线运行 ID' },
        stage_id: { type: 'string', description: '阶段 ID' },
        verdict: { type: 'string', enum: ['pass', 'block'], description: '裁决结果' },
        report: { type: 'string', description: '审查报告（JSON 字符串或纯文本）' },
      },
      required: ['pipeline_run_id', 'stage_id', 'verdict', 'report'],
    },
    async (args) => {
      if (!ctx.systemManager?.pipelineEngine) {
        return '流水线引擎未初始化。';
      }
      try {
        let report: unknown;
        try {
          report = JSON.parse(args.report as string);
        } catch {
          report = args.report as string;
        }
        ctx.systemManager.pipelineEngine.submitVerdict(
          args.pipeline_run_id as string,
          args.stage_id as string,
          args.verdict as 'pass' | 'block',
          report,
        );
        return `裁决已提交: ${args.verdict} (阶段: ${args.stage_id})`;
      } catch (e: unknown) {
        return `提交裁决失败: ${(e as Error).message}`;
      }
    },
  ));

  return tools;
}

// ═══════════════════════════════════════════
// 获取所有工具定义（用于发给 LLM API）
// ═══════════════════════════════════════════

/**
 * 将核心工具 + MCP 工具 + 动态工具合并，返回定义列表
 * 支持可选的角色白名单过滤
 */
export function getAllToolDefinitions(coreTools: ToolEntry[], role?: AgentRole): ToolDefinition[] {
  let defs: ToolDefinition[] = coreTools.map((t) => t.definition);

  // 动态注册的工具
  for (const def of toolDefinitions) {
    if (dynamicToolHandlers.has(def.function.name)) {
      defs.push(def);
    }
  }

  // 角色白名单过滤
  if (role?.allowedTools && role.allowedTools.length > 0) {
    const allowed = new Set(role.allowedTools);
    defs = defs.filter((d) => allowed.has(d.function.name));
  }

  return defs;
}

/**
 * 根据工具名在核心工具 + 动态工具中查找 handler 并执行
 */
export async function executeToolByName(
  name: string,
  args: Record<string, unknown>,
  coreTools: ToolEntry[],
  systemManager: SystemManagerInterface | null,
  agentId: string,
): Promise<string | ToolHalt> {
  // 核心工具
  const coreTool = coreTools.find((t) => t.definition.function.name === name);
  if (coreTool) {
    return await coreTool.handler(args);
  }

  // 动态注册的工具
  if (dynamicToolHandlers.has(name)) {
    const handler = dynamicToolHandlers.get(name)!;
    return await handler(args, { systemManager, agentId });
  }

  // MCP 工具
  if (isMCPTool(name)) {
    return await executeMCPTool(name, args);
  }

  return `未知工具: ${name}`;
}

/**
 * 兼容层：executeTool（用于 MCP 等外部场景）
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  systemManager: SystemManagerInterface | null,
  agentId: string,
): Promise<string> {
  if (dynamicToolHandlers.has(name)) {
    const handler = dynamicToolHandlers.get(name)!;
    return await handler(args, { systemManager, agentId });
  }
  if (isMCPTool(name)) {
    return await executeMCPTool(name, args);
  }
  return `未知工具: ${name}`;
}

/**
 * 获取动态注册的工具定义列表（插件注册的）
 */
export function getLegacyTools(): ToolDefinition[] {
  return toolDefinitions.filter((def) => dynamicToolHandlers.has(def.function.name));
}

// ═══════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'M';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + 'G';
}

function isSafeCommand(command: string): boolean | string {
  const dangerous = ['rm -rf /', 'mkfs', 'dd if=', '> /dev/sda'];
  for (const d of dangerous) {
    if (command.includes(d)) return false;
  }
  if (command.trim().startsWith('sudo ')) {
    return 'SUDO_BLOCKED';
  }
  return true;
}

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
}

function runShellCommand(
  command: string,
  options: { cwd?: string; timeout?: number } = {},
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const timeout = options.timeout || 10000;
    exec(
      command,
      { cwd: options.cwd, timeout },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
          error: error ? error.message : null,
        });
      },
    );
  });
}
