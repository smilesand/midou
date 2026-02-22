/**
 * 工具系统 — midou 与世界交互的能力
 */

import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { isMCPTool, executeMCPTool } from './mcp.js';
import { listSkillNames, loadSkillContent } from './skills.js';
import { addMemory, searchMemory } from './rag/index.js';
import { addTodoItem, updateTodoStatus, getTodoItems, clearTodoItems } from './todo.js';
import dayjs from 'dayjs';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';

export const dynamicToolHandlers = new Map();

export function registerTool(definition, handler) {
  // Check if tool already exists to prevent duplicates on reload
  const existingIndex = toolDefinitions.findIndex(t => t.function.name === definition.function.name);
  if (existingIndex >= 0) {
    toolDefinitions[existingIndex] = definition;
  } else {
    toolDefinitions.push(definition);
  }
  dynamicToolHandlers.set(definition.function.name, handler);
}

/**
 * 工具定义（OpenAI Function Calling 格式）
 */
export let toolDefinitions = [
  // ── 任务控制 ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'finish_task',
      description: '当任务彻底完成时调用此工具，结束当前任务循环。',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '任务完成的总结说明',
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '当尝试了所有方法仍然失败，或者需要用户提供无法通过代码获取的信息（如密码、确认等）时调用此工具，暂停任务并向用户提问。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '向用户提出的问题',
          },
        },
        required: ['question'],
      },
    },
  },

  // ── 记忆与日志 ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '使用 RAG (Retrieval-Augmented Generation) 搜索长期记忆，获取历史对话中总结的重要事实、用户偏好或未完成的任务。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词或自然语言问题',
          },
          limit: {
            type: 'number',
            description: '返回的记忆条数（默认 5）',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_memory',
      description: '将重要信息、事实或总结存入 Transformer 长期记忆库中。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '要记忆的内容',
          },
          importance: {
            type: 'number',
            description: '重要性评分 (1-5，5最重要，默认 3)',
          },
          type: {
            type: 'string',
            enum: ['semantic', 'episodic'],
            description: '记忆类型：semantic(语义/事实/规则) 或 episodic(情景/事件/日志)，默认 semantic'
          }
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_agent_log',
      description: '读取指定 Agent 在某天的对话日志。',
      parameters: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'Agent 的名称',
          },
          days_ago: {
            type: 'number',
            description: '读取几天前的日志（0 表示今天，1 表示昨天，以此类推）',
          },
        },
        required: ['agent_name', 'days_ago'],
      },
    },
  },

  // ── 组织协作与通信 ──────────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_organization_roster',
      description: '读取组织花名册，了解组织里有哪些 Agent，以及他们各自的角色和能力。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: '通过消息总线向其他 Agent 发送消息。',
      parameters: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: '目标 Agent 的 ID',
          },
          message: {
            type: 'string',
            description: '要发送的消息内容',
          },
          context: {
            type: 'object',
            description: '附加的上下文信息（可选）',
          },
        },
        required: ['target_agent_id', 'message'],
      },
    },
  },

  // ── 系统级工具 ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在终端中执行 shell 命令。注意：危险命令会被拦截。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令',
          },
          cwd: {
            type: 'string',
            description: '工作目录（可选）',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 10000',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_system_file',
      description: '读取系统中的任意文件（需要绝对路径或相对路径）。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径',
          },
          encoding: {
            type: 'string',
            description: '编码，默认 utf-8',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_system_file',
      description: '写入系统中的任意文件。如果目录不存在会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径',
          },
          content: {
            type: 'string',
            description: '要写入的内容',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_system_dir',
      description: '列出系统中的目录内容。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目录路径',
          },
          details: {
            type: 'boolean',
            description: '是否显示详细信息（大小、修改时间等）',
          },
        },
        required: ['path'],
      },
    },
  },

  // ── 技能系统 ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: '列出所有可用的技能。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '加载某个技能的详细指令。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: '技能名称',
          },
        },
        required: ['skill_name'],
      },
    },
  },

  // ── TODO 工作流 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description: '更新任务状态或备注。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '任务 ID',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'blocked'],
            description: '新状态（可选）',
          },
          notes: {
            type: 'string',
            description: '任务备注或执行结果（可选）',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: '列出所有工作任务。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

/**
 * 执行工具调用
 */
export async function executeTool(name, args, systemManager, agentId) {
  if (dynamicToolHandlers.has(name)) {
    const handler = dynamicToolHandlers.get(name);
    return await handler(args, { systemManager, agentId });
  }

  if (isMCPTool(name)) {
    return await executeMCPTool(name, args);
  }

  switch (name) {
    // ── 任务控制 ──
    case 'finish_task':
      return `任务已完成: ${args.summary}`;
    case 'ask_user':
      return `等待用户回复: ${args.question}`;

    // ── 记忆与日志 ──
    case 'search_memory': {
      try {
        const results = await searchMemory(agentId, args.query, args.limit || 5);
        if (!results || results.length === 0) return `未找到与 "${args.query}" 相关的记忆。`;
        
        return results.map((r, i) => {
          const weight = (r.attentionWeight * 100).toFixed(1) + '%';
          const rel = r.metrics.isRelational ? ' [关联推理]' : '';
          return `[记忆 ${i+1}] (注意力权重: ${weight}${rel} | 类型: ${r.type}):\n${r.content}`;
        }).join('\n\n');
      } catch (e) {
        return `搜索记忆失败: ${e.message}`;
      }
    }
    case 'add_memory': {
      try {
        const id = await addMemory(agentId, args.content, args.importance || 3, args.type || 'semantic');
        return `已成功将内容存入 Transformer 记忆库 (ID: ${id}, 类型: ${args.type || 'semantic'})。`;
      } catch (e) {
        return `添加记忆失败: ${e.message}`;
      }
    }
    case 'read_agent_log': {
      const date = dayjs().subtract(args.days_ago, 'day').format('YYYY-MM-DD');
      const logPath = `agents/${args.agent_name}/memory/${date}.md`;
      try {
        const content = await fs.readFile(path.join(MIDOU_WORKSPACE_DIR, logPath), 'utf-8');
        return content || `Agent ${args.agent_name} 在 ${date} 没有日志记录。`;
      } catch (e) {
        return `无法读取 Agent ${args.agent_name} 在 ${date} 的日志。`;
      }
    }

    // ── 组织协作与通信 ──
    case 'read_organization_roster':
      if (systemManager) {
        return systemManager.getOrganizationRoster(agentId);
      }
      return '组织花名册功能尚未完全实现。';

    case 'send_message':
      if (systemManager) {
        return await systemManager.sendMessage(agentId, args.target_agent_id, args.message, args.context);
      }
      return '消息总线功能尚未完全实现。';

    // ── 技能系统 ──
    case 'list_skills': {
      const skills = await listSkillNames();
      if (skills.length === 0) return '当前没有可用的技能。';
      return skills.join('\n');
    }
    case 'load_skill': {
      const content = await loadSkillContent(args.skill_name);
      return content || `未找到技能: ${args.skill_name}`;
    }

    // ── 系统级工具 ──
    case 'run_command': {
      const safeCheck = isSafeCommand(args.command);
      if (safeCheck === 'SUDO_BLOCKED') {
        return '⚠️ 该命令需要管理员权限。出于安全考虑，绝对禁止向用户索要密码。请直接将需要执行的命令输出给用户，让用户自己在一个安全的终端中手动执行。';
      } else if (!safeCheck) {
        return '⚠️ 该命令被安全策略拦截。如果确实需要执行，请通知用户手动操作。';
      }

      let cwd = args.cwd;
      if (!cwd && systemManager && agentId) {
        const agent = systemManager.agents.get(agentId);
        if (agent) {
          cwd = agent.workspaceDir;
        }
      }

      const result = await runShellCommand(args.command, {
        cwd: cwd,
        timeout: args.timeout,
      });
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
      output += `\n[exit code: ${result.exitCode}]`;
      // 截断过长的输出
      if (output.length > 8000) {
        output = output.slice(0, 8000) + '\n... [输出已截断]';
      }
      return output;
    }

    case 'read_system_file': {
      try {
        const encoding = args.encoding || 'utf-8';
        const content = await fs.readFile(args.path, encoding);
        // 截断过长内容
        if (content.length > 10000) {
          return content.slice(0, 10000) + '\n... [内容已截断，共 ' + content.length + ' 字符]';
        }
        return content;
      } catch (err) {
        return `无法读取文件 ${args.path}: ${err.message}`;
      }
    }

    case 'write_system_file': {
      try {
        await fs.mkdir(path.dirname(args.path), { recursive: true });
        await fs.writeFile(args.path, args.content, 'utf-8');
        return `已写入 ${args.path}`;
      } catch (err) {
        return `无法写入文件 ${args.path}: ${err.message}`;
      }
    }

    case 'list_system_dir': {
      try {
        const entries = await fs.readdir(args.path, { withFileTypes: true });
        const lines = entries.map(e => {
          const type = e.isDirectory() ? '📁' : '📄';
          return `${type} ${e.name}`;
        });

        if (args.details) {
          const detailed = [];
          for (const e of entries) {
            try {
              const stat = await fs.stat(path.join(args.path, e.name));
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

        return lines.join('\n') || '（空目录）';
      } catch (err) {
        return `无法列出目录 ${args.path}: ${err.message}`;
      }
    }

    // ── TODO 工作流 ──
    case 'update_todo': {
      const updates = {};
      if (args.status) updates.status = args.status;
      if (args.notes) updates.notes = args.notes;
      
      const item = await updateTodoStatus(args.id, updates);
      if (!item) return `未找到任务 [${args.id}]`;
      const statusMap = { pending: '待办', in_progress: '进行中', done: '✓ 完成', blocked: '阻塞' };
      return `任务 [${item.id}] "${item.title}" 已更新。当前状态: ${statusMap[item.status] || item.status}`;
    }

    case 'list_todos': {
      const items = await getTodoItems(agentId);
      if (items.length === 0) return '当前没有工作任务';
      const statusIcon = { pending: '□', in_progress: '►', done: '✓', blocked: '✗' };
      return items.map(i => `[${i.id}] ${statusIcon[i.status] || '?'} ${i.title}${i.description ? ' — ' + i.description : ''}${i.notes ? ' (备注: ' + i.notes + ')' : ''}`).join('\n');
    }

    default:
      return `未知工具: ${name}`;
  }
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'M';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + 'G';
}

/**
 * 检查命令是否安全
 */
function isSafeCommand(command) {
  const dangerous = ['rm -rf /', 'mkfs', 'dd if=', '> /dev/sda'];
  for (const d of dangerous) {
    if (command.includes(d)) return false;
  }
  if (command.trim().startsWith('sudo ')) {
    return 'SUDO_BLOCKED';
  }
  return true;
}

/**
 * 执行 shell 命令
 */
function runShellCommand(command, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 10000;
    const child = exec(command, { cwd: options.cwd, timeout }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code : 0,
        error: error ? error.message : null,
      });
    });
  });
}
