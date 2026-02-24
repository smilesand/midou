/**
 * 工具系统 — midou 与世界交互的能力
 *
 * 使用 NodeLLM 的 Tool 类定义工具，同时保持与旧版 JSON 格式的兼容性。
 * 支持动态注册插件工具、MCP 工具。
 */

import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { Tool, z } from '@node-llm/core';
import { isMCPTool, executeMCPTool } from './mcp.js';
import { listSkillNames, loadSkillContent } from './skills.js';
import { memoryManager } from './memory.js';
import {
  addTodoItem,
  updateTodoStatus,
  getTodoItems,
} from './todo.js';
import dayjs from 'dayjs';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  ToolDefinition,
  ToolHandler,
  SystemManagerInterface,
} from './types.js';

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
// NodeLLM Tool 类定义
// ═══════════════════════════════════════════

// 工具执行上下文（通过闭包传入）
export interface ToolContext {
  systemManager: SystemManagerInterface | null;
  agentId: string;
}

/**
 * 创建所有核心工具实例
 */
export function createCoreTools(ctx: ToolContext): Tool[] {
  const tools: Tool[] = [];

  // ── finish_task ──
  class FinishTaskTool extends Tool {
    name = 'finish_task';
    description = '当任务彻底完成时调用此工具，结束当前任务循环。';
    schema = z.object({
      summary: z.string().describe('任务完成的总结说明'),
    });
    async execute({ summary }: { summary: string }) {
      return this.halt(`任务已完成: ${summary}`);
    }
  }
  tools.push(new FinishTaskTool());

  // ── ask_user ──
  class AskUserTool extends Tool {
    name = 'ask_user';
    description = '向用户提出问题，等待用户回复。当你需要用户的输入或确认时使用此工具。';
    schema = z.object({
      question: z.string().describe('要问用户的问题'),
    });
    async execute({ question }: { question: string }) {
      return this.halt(`[等待用户回复] ${question}`);
    }
  }
  tools.push(new AskUserTool());

  // ── search_memory ──
  class SearchMemoryTool extends Tool {
    name = 'search_memory';
    description = '搜索长期记忆，获取历史对话中总结的重要事实、用户偏好或未完成的任务。';
    schema = z.object({
      query: z.string().describe('搜索关键词或自然语言问题'),
      limit: z.number().optional().describe('返回的记忆条数（默认 5）'),
    });
    async execute({ query, limit }: { query: string; limit?: number }) {
      try {
        const results = await memoryManager.searchMemory(ctx.agentId, query, limit || 5);
        if (!results || results.length === 0) return `未找到与 "${query}" 相关的记忆。`;
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
    }
  }
  tools.push(new SearchMemoryTool());

  // ── add_memory ──
  class AddMemoryTool extends Tool {
    name = 'add_memory';
    description = '将重要信息、事实或总结存入长期记忆库中。';
    schema = z.object({
      content: z.string().describe('要记忆的内容'),
      importance: z.number().optional().describe('重要性评分 (1-5，5最重要，默认 3)'),
      type: z.enum(['semantic', 'episodic']).optional().describe('记忆类型'),
    });
    async execute({ content, importance, type }: { content: string; importance?: number; type?: string }) {
      try {
        const id = await memoryManager.addMemory(ctx.agentId, content, type || 'semantic', importance || 3);
        return `已成功将内容存入记忆库 (ID: ${id}, 类型: ${type || 'semantic'})。`;
      } catch (e: unknown) {
        return `添加记忆失败: ${(e as Error).message}`;
      }
    }
  }
  tools.push(new AddMemoryTool());

  // ── read_agent_log ──
  class ReadAgentLogTool extends Tool {
    name = 'read_agent_log';
    description = '读取指定 Agent 在某天的对话日志。';
    schema = z.object({
      agent_name: z.string().describe('Agent 的名称'),
      days_ago: z.number().describe('读取几天前的日志'),
    });
    async execute({ agent_name, days_ago }: { agent_name: string; days_ago: number }) {
      const date = dayjs().subtract(days_ago, 'day').format('YYYY-MM-DD');
      const logPath = `agents/${agent_name}/memory/${date}.md`;
      try {
        const content = await fs.readFile(path.join(MIDOU_WORKSPACE_DIR, logPath), 'utf-8');
        return content || `Agent ${agent_name} 在 ${date} 没有日志记录。`;
      } catch {
        return `无法读取 Agent ${agent_name} 在 ${date} 的日志。`;
      }
    }
  }
  tools.push(new ReadAgentLogTool());

  // ── read_organization_roster ──
  class ReadOrganizationRosterTool extends Tool {
    name = 'read_organization_roster';
    description = '读取组织花名册，了解组织里有哪些 Agent。';
    schema = z.object({});
    async execute() {
      if (ctx.systemManager) {
        return ctx.systemManager.getOrganizationRoster(ctx.agentId);
      }
      return '组织花名册功能尚未初始化。';
    }
  }
  tools.push(new ReadOrganizationRosterTool());

  // ── send_message ──
  class SendMessageTool extends Tool {
    name = 'send_message';
    description = '通过消息总线向其他成员发送消息。';
    schema = z.object({
      target_agent_id: z.string().describe('目标成员的 ID'),
      message: z.string().describe('要发送的消息内容'),
    });
    async execute({ target_agent_id, message }: { target_agent_id: string; message: string }) {
      if (ctx.systemManager) {
        return await ctx.systemManager.sendMessage(ctx.agentId, target_agent_id, message);
      }
      return '消息总线功能尚未初始化。';
    }
  }
  tools.push(new SendMessageTool());

  // ── create_agent ──
  class CreateAgentTool extends Tool {
    name = 'create_agent';
    description = '创建一个智能体来帮你完成特定任务。';
    schema = z.object({
      name: z.string().optional().describe('智能体的名称'),
      system_prompt: z.string().optional().describe('智能体的系统提示词'),
      task: z.string().describe('分配给智能体的具体任务描述'),
    });
    async execute({ name, system_prompt, task }: { name?: string; system_prompt?: string; task: string }) {
      if (ctx.systemManager) {
        return await ctx.systemManager.createChildAgent(ctx.agentId, {
          name,
          systemPrompt: system_prompt,
          task,
        });
      }
      return '子 Agent 创建功能尚未初始化。';
    }
  }
  tools.push(new CreateAgentTool());

  // ── run_command ──
  class RunCommandTool extends Tool {
    name = 'run_command';
    description = '在终端中执行 shell 命令。注意：危险命令会被拦截。';
    schema = z.object({
      command: z.string().describe('要执行的 shell 命令'),
      cwd: z.string().optional().describe('工作目录'),
      timeout: z.number().optional().describe('超时时间（毫秒），默认 10000'),
    });
    async execute({ command, cwd, timeout }: { command: string; cwd?: string; timeout?: number }) {
      const safeCheck = isSafeCommand(command);
      if (safeCheck === 'SUDO_BLOCKED') {
        return '⚠️ 该命令需要管理员权限。请直接将命令输出给用户，让用户手动执行。';
      } else if (!safeCheck) {
        return '⚠️ 该命令被安全策略拦截。';
      }

      let workDir = cwd;
      if (!workDir && ctx.systemManager && ctx.agentId) {
        const agent = ctx.systemManager.agents.get(ctx.agentId);
        if (agent) workDir = agent.workspaceDir;
      }

      const result = await runShellCommand(command, { cwd: workDir, timeout: timeout || 10000 });
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
      output += `\n[exit code: ${result.exitCode}]`;
      if (output.length > 8000) {
        output = output.slice(0, 8000) + '\n... [输出已截断]';
      }
      return output;
    }
  }
  tools.push(new RunCommandTool());

  // ── read_system_file ──
  class ReadSystemFileTool extends Tool {
    name = 'read_system_file';
    description = '读取系统中的任意文件。';
    schema = z.object({
      path: z.string().describe('文件路径'),
      encoding: z.string().optional().describe('编码，默认 utf-8'),
    });
    async execute({ path: filePath, encoding }: { path: string; encoding?: string }) {
      try {
        const enc = (encoding || 'utf-8') as BufferEncoding;
        const content = await fs.readFile(filePath, enc);
        if (content.length > 10000) {
          return content.slice(0, 10000) + '\n... [内容已截断，共 ' + content.length + ' 字符]';
        }
        return content;
      } catch (err: unknown) {
        return `无法读取文件 ${filePath}: ${(err as Error).message}`;
      }
    }
  }
  tools.push(new ReadSystemFileTool());

  // ── write_system_file ──
  class WriteSystemFileTool extends Tool {
    name = 'write_system_file';
    description = '写入系统中的任意文件。如果目录不存在会自动创建。';
    schema = z.object({
      path: z.string().describe('文件路径'),
      content: z.string().describe('要写入的内容'),
    });
    async execute({ path: filePath, content }: { path: string; content: string }) {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return `已写入 ${filePath}`;
      } catch (err: unknown) {
        return `无法写入文件 ${filePath}: ${(err as Error).message}`;
      }
    }
  }
  tools.push(new WriteSystemFileTool());

  // ── list_system_dir ──
  class ListSystemDirTool extends Tool {
    name = 'list_system_dir';
    description = '列出系统中的目录内容。';
    schema = z.object({
      path: z.string().describe('目录路径'),
      details: z.boolean().optional().describe('是否显示详细信息'),
    });
    async execute({ path: dirPath, details }: { path: string; details?: boolean }) {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        if (details) {
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
    }
  }
  tools.push(new ListSystemDirTool());

  // ── list_skills ──
  class ListSkillsTool extends Tool {
    name = 'list_skills';
    description = '列出所有可用的技能。';
    schema = z.object({});
    async execute() {
      const skills = await listSkillNames();
      return skills.length === 0 ? '当前没有可用的技能。' : skills.join('\n');
    }
  }
  tools.push(new ListSkillsTool());

  // ── load_skill ──
  class LoadSkillTool extends Tool {
    name = 'load_skill';
    description = '加载某个技能的详细指令。';
    schema = z.object({
      skill_name: z.string().describe('技能名称'),
    });
    async execute({ skill_name }: { skill_name: string }) {
      const content = await loadSkillContent(skill_name);
      return content || `未找到技能: ${skill_name}`;
    }
  }
  tools.push(new LoadSkillTool());

  // ── create_todo ──
  class CreateTodoTool extends Tool {
    name = 'create_todo';
    description = '创建一个新的工作任务（TODO）。';
    schema = z.object({
      title: z.string().describe('任务标题'),
      description: z.string().optional().describe('任务详细描述'),
      agent_id: z.string().optional().describe('指派对象的 Agent ID 或名称'),
    });
    async execute({ title, description, agent_id }: { title: string; description?: string; agent_id?: string }) {
      let targetAgentId = agent_id || ctx.agentId;
      if (ctx.systemManager?.agents && !ctx.systemManager.agents.has(targetAgentId)) {
        const matchedAgent = Array.from(ctx.systemManager.agents.values()).find((a) => a.name === targetAgentId);
        if (matchedAgent) targetAgentId = matchedAgent.id;
      }
      const item = await addTodoItem(targetAgentId, title, description || '');
      return `已创建任务 [${item.id}]: ${item.title} (指派给: ${targetAgentId})`;
    }
  }
  tools.push(new CreateTodoTool());

  // ── update_todo ──
  class UpdateTodoTool extends Tool {
    name = 'update_todo';
    description = '更新任务状态或备注。';
    schema = z.object({
      id: z.string().describe('任务 ID'),
      status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional().describe('新状态'),
      notes: z.string().optional().describe('任务备注或执行结果'),
    });
    async execute({ id, status, notes }: { id: string; status?: string; notes?: string }) {
      const updates: Record<string, string> = {};
      if (status) updates.status = status;
      if (notes) updates.notes = notes;
      const item = await updateTodoStatus(id, updates);
      if (!item) return `未找到任务 [${id}]`;
      const statusMap: Record<string, string> = {
        pending: '待办', in_progress: '进行中', done: '✓ 完成', blocked: '阻塞',
      };
      return `任务 [${item.id}] "${item.title}" 已更新。状态: ${statusMap[item.status] || item.status}`;
    }
  }
  tools.push(new UpdateTodoTool());

  // ── list_todos ──
  class ListTodosTool extends Tool {
    name = 'list_todos';
    description = '列出所有工作任务。';
    schema = z.object({});
    async execute() {
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
    }
  }
  tools.push(new ListTodosTool());

  return tools;
}

/**
 * 将 MCP 工具和动态注册的工具转换为 NodeLLM 的 function-based 格式
 */
export function getLegacyTools(): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];

  // 从 toolDefinitions（插件注册的）转换
  for (const def of toolDefinitions) {
    if (!dynamicToolHandlers.has(def.function.name)) continue;
    tools.push({
      type: 'function',
      function: {
        name: def.function.name,
        description: def.function.description,
        parameters: def.function.parameters,
      },
      handler: async (args: Record<string, unknown>) => {
        const handler = dynamicToolHandlers.get(def.function.name)!;
        return await handler(args, { systemManager: null, agentId: '' });
      },
    });
  }

  return tools;
}

// ═══════════════════════════════════════════
// 兼容层：executeTool（用于非 NodeLLM 场景）
// ═══════════════════════════════════════════

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  systemManager: SystemManagerInterface | null,
  agentId: string
): Promise<string> {
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
  options: { cwd?: string; timeout?: number } = {}
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
      }
    );
  });
}
