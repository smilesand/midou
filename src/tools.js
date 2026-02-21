/**
 * 工具系统 — midou 与世界交互的能力
 * 
 * 这些工具让 midou 能够：
 * - 读写文件（灵魂文件 + 系统文件）
 * - 管理记忆
 * - 自我进化
 * - 定时提醒
 * - 加载技能
 * - 执行系统命令
 * - 使用 MCP 扩展
 */

import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { readFile, writeFile, appendFile, deleteFile, listDir } from './soul.js';
import { addLongTermMemory, writeJournal } from './memory.js';
import { addReminder, removeReminder, formatReminders } from './scheduler.js';
import { loadSkillContent, listSkillNames } from './skills.js';
import { isMCPTool, executeMCPTool } from './mcp.js';
import { addTodoItem, updateTodoStatus, getTodoItems, clearTodoItems } from './ui.js';
import { MIDOU_HOME } from '../midou.config.js';

/**
 * 工具定义（OpenAI Function Calling 格式）
 */
export const toolDefinitions = [
  // ── 灵魂 / 工作区文件操作 ──────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区中的文件。可以读取灵魂文件、记忆、日记，也可以读取源代码。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径，相对于工作区根目录。例如：SOUL.md, memory/2026-02-19.md, ../src/index.js',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或覆写工作区中的文件。可以用来修改灵魂文件、更新身份、修改代码等。如果修改了灵魂文件(SOUL.md)，必须告诉主人。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径，相对于工作区根目录',
          },
          content: {
            type: 'string',
            description: '文件内容',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: '追加内容到文件末尾',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径，相对于工作区根目录',
          },
          content: {
            type: 'string',
            description: '要追加的内容',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除工作区中的文件',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径，相对于工作区根目录',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录中的文件和子目录',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目录路径，相对于工作区根目录。留空则列出工作区根目录',
          },
        },
        required: [],
      },
    },
  },

  // ── 记忆系统 ──────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description: '将重要信息写入长期记忆 (MEMORY.md)。用于保存从对话中提炼的重要信息。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '要记忆的内容',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_journal',
      description: '写入今日日记。用于记录当天的想法、对话摘要或重要事件。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '日记内容',
          },
        },
        required: ['content'],
      },
    },
  },

  // ── 灵魂进化 ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'evolve_soul',
      description: '修改自己的灵魂文件 (SOUL.md)。这是自我进化的方式。使用此工具时务必告知主人你做了什么改变。',
      parameters: {
        type: 'object',
        properties: {
          new_soul: {
            type: 'string',
            description: '新的 SOUL.md 完整内容',
          },
          reason: {
            type: 'string',
            description: '进化的原因——为什么要改变',
          },
        },
        required: ['new_soul', 'reason'],
      },
    },
  },

  // ── 定时提醒 ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '设置定时任务。支持：一次性(N分钟后触发并自动删除)、间隔重复(每N分钟)、每天/每周/每月固定时间(永久保存，重启后自动加载)。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '提醒内容，例如"该休息一下了"',
          },
          reminder_type: {
            type: 'string',
            enum: ['once', 'interval', 'daily', 'weekly', 'monthly'],
            description: '任务类型。once=一次性(触发后删除)，interval=每隔N分钟重复，daily=每天固定时间，weekly=每周固定时间，monthly=每月固定时间',
          },
          interval_minutes: {
            type: 'number',
            description: 'once/interval 类型的分钟数。例如 20 表示 20 分钟后或每 20 分钟',
          },
          time: {
            type: 'string',
            description: 'daily/weekly/monthly 类型的触发时间，格式 HH:MM，例如"09:00"',
          },
          weekday: {
            type: 'number',
            description: 'weekly 类型的星期几（0=周日，1=周一，...，6=周六）',
          },
          day: {
            type: 'number',
            description: 'monthly 类型的日期（1-31）',
          },
        },
        required: ['text', 'reminder_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '列出当前所有定时任务（包括一次性提醒和永久定时任务）',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: '取消/删除一个定时任务',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: '要取消的任务 ID',
          },
        },
        required: ['id'],
      },
    },
  },

  // ── 技能系统 ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: '列出所有可用的技能（来自 .claude/skills 和 .midou/skills）',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '加载一个技能的完整指令，以便执行该技能定义的任务。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: '要加载的技能名称',
          },
        },
        required: ['skill_name'],
      },
    },
  },

  // ── 系统级工具 ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'request_secret_input',
      description: '当需要用户输入敏感信息（如 API Key、密码）时使用此工具。它会弹出一个安全的输入框，用户输入的内容不会出现在聊天记录中，而是直接写入到指定的配置文件中。',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: '提示用户输入的信息，例如 "请输入 Brave Search API Key"',
          },
          target: {
            type: 'string',
            description: '保存目标：env (保存到 .env 文件) 或 mcp (保存到 mcp.json)',
            enum: ['env', 'mcp'],
          },
          keyName: {
            type: 'string',
            description: '环境变量名或 JSON 键名，例如 BRAVE_API_KEY',
          },
          mcpServerName: {
            type: 'string',
            description: '如果 target 是 mcp，则必须提供对应的 MCP 服务器名称',
          },
        },
        required: ['message', 'target', 'keyName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在系统终端中执行 shell 命令。可以用来整理文件、安装软件、查看系统信息、运行脚本等。注意：危险命令（如 rm -rf /）会被拦截。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令',
          },
          cwd: {
            type: 'string',
            description: '命令执行的工作目录（可选，默认为用户主目录）',
          },
          timeout: {
            type: 'number',
            description: '超时时间（秒），默认 30 秒',
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
      description: '读取系统中任意位置的文件（需使用绝对路径）。可以读取用户目录、项目文件、配置文件等。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件的绝对路径，例如 /home/midoumao/Documents/notes.md',
          },
          encoding: {
            type: 'string',
            description: '文件编码，默认 utf-8。二进制文件使用 base64',
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
      description: '写入系统中任意位置的文件（需使用绝对路径）。可以创建或覆盖文件。会自动创建不存在的父目录。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件的绝对路径',
          },
          content: {
            type: 'string',
            description: '文件内容',
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
      description: '列出系统中任意目录的内容（需使用绝对路径）。返回文件名和类型（文件/目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目录的绝对路径，例如 /home/midoumao/Documents',
          },
          details: {
            type: 'boolean',
            description: '是否显示详细信息（大小、修改时间）',
          },
        },
        required: ['path'],
      },
    },
  },

  // ── TODO 工作流 ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description: '创建一个工作任务。当你需要完成复杂工作时，先建立工作计划，再逐步执行。任务会显示在 UI 的工作计划面板中。',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '任务标题，简短描述',
          },
          description: {
            type: 'string',
            description: '任务的详细描述（可选）',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description: '更新任务状态。状态值：pending(待办)、in_progress(进行中)、done(完成)、blocked(阻塞)',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: '任务 ID',
          },
          status: {
            type: 'string',
            description: '新状态：pending, in_progress, done, blocked',
            enum: ['pending', 'in_progress', 'done', 'blocked'],
          },
        },
        required: ['id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: '列出当前所有工作任务及其状态',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_todos',
      description: '清空所有工作任务（工作完成后使用）',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

// ── 危险命令黑名单 ──────────────────────────────────
const DANGEROUS_PATTERNS = [
  /rm\s+(-[rRf]+\s+)*\//,                    // rm -rf /
  /mkfs/,                                      // 格式化
  /dd\s+if=.*of=\/dev/,                        // 写入磁盘设备
  /:(){ :\|:& };:/,                            // fork bomb
  />\s*\/dev\/[sh]d/,                          // 写入磁盘设备
  /chmod\s+(-R\s+)?777\s+\//,                  // chmod 777 /
  /shutdown|reboot|poweroff|halt/,             // 关机重启
];

/**
 * 检查命令是否安全
 */
function isSafeCommand(command) {
  // 拦截 sudo 和 su，防止 AI 索要密码
  if (/^(sudo|su)\s+/.test(command.trim())) {
    return 'SUDO_BLOCKED';
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return false;
  }
  return true;
}

/**
 * 执行 shell 命令
 */
function runShellCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = (options.timeout || 30) * 1000;
    const cwd = options.cwd || process.env.HOME;

    const child = exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ stdout: stdout || '', stderr: '命令执行超时', exitCode: -1 });
      } else if (error) {
        resolve({ stdout: stdout || '', stderr: stderr || error.message, exitCode: error.code || 1 });
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: 0 });
      }
    });
  });
}

/**
 * 执行工具调用
 */
export async function executeTool(name, args, context = {}) {
  // 先检查是否是 MCP 工具
  if (isMCPTool(name)) {
    return await executeMCPTool(name, args);
  }

  switch (name) {
    // ── 灵魂/工作区文件 ──
    case 'read_file': {
      const content = await readFile(args.path);
      return content || `文件 ${args.path} 不存在`;
    }

    case 'write_file': {
      await writeFile(args.path, args.content);
      return `已写入 ${args.path}`;
    }

    case 'append_file': {
      await appendFile(args.path, args.content);
      return `已追加内容到 ${args.path}`;
    }

    case 'delete_file': {
      const success = await deleteFile(args.path);
      return success ? `已删除 ${args.path}` : `无法删除 ${args.path}`;
    }

    case 'list_dir': {
      const files = await listDir(args.path || '.');
      return files.length > 0 ? files.join('\n') : '（空目录）';
    }

    // ── 记忆 ──
    case 'write_memory': {
      await addLongTermMemory(args.content);
      return '已写入长期记忆';
    }

    case 'write_journal': {
      await writeJournal(args.content);
      return '已写入今日日记';
    }

    // ── 灵魂进化 ──
    case 'evolve_soul': {
      await writeFile('SOUL.md', args.new_soul);
      return `灵魂已进化。原因：${args.reason}`;
    }

    // ── 定时任务 ──
    case 'set_reminder': {
      const rType = args.reminder_type || 'once';
      const reminder = await addReminder(args.text, {
        type: rType,
        intervalMinutes: args.interval_minutes,
        time: args.time,
        weekday: args.weekday,
        day: args.day,
      });
      const typeLabels = { once: '一次性', interval: `每 ${reminder.intervalMinutes} 分钟`, daily: `每天 ${reminder.time}`, weekly: `每周 ${reminder.time}`, monthly: `每月 ${reminder.time}` };
      return `已设置任务 [${reminder.id}]: "${reminder.text}" (${typeLabels[reminder.type] || reminder.type})，下次触发: ${reminder.nextTrigger}`;
    }

    case 'list_reminders': {
      return formatReminders();
    }

    case 'cancel_reminder': {
      const removed = await removeReminder(args.id);
      return removed ? `已取消任务 [${args.id}]` : `未找到任务 [${args.id}]`;
    }

    // ── 技能 ──
    case 'list_skills': {
      const skills = await listSkillNames();
      return skills.length > 0 ? skills.join('\n') : '当前没有可用的技能';
    }

    case 'load_skill': {
      const content = await loadSkillContent(args.skill_name);
      return content || `未找到技能: ${args.skill_name}`;
    }

    // ── 系统级工具 ──
    case 'request_secret_input': {
      if (!context.output || !context.output.askSecret) {
        return '⚠️ 当前环境不支持安全输入框。';
      }
      const secret = await context.output.askSecret(args.message);
      if (!secret) {
        return '用户取消了输入。';
      }

      try {
        if (args.target === 'env') {
          const envPath = path.join(MIDOU_HOME, '.env');
          let envContent = '';
          try { envContent = await fs.readFile(envPath, 'utf-8'); } catch (e) {}
          
          const regex = new RegExp(`^${args.keyName}=.*$`, 'm');
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${args.keyName}=${secret}`);
          } else {
            envContent += (envContent && !envContent.endsWith('\n') ? '\n' : '') + `${args.keyName}=${secret}\n`;
          }
          await fs.writeFile(envPath, envContent, 'utf-8');
          return `✅ 密钥已安全保存到 .env 文件中的 ${args.keyName}。`;
        } else if (args.target === 'mcp') {
          if (!args.mcpServerName) return '⚠️ 缺少 mcpServerName 参数。';
          const mcpPath = path.join(MIDOU_HOME, 'mcp.json');
          let mcpConfig = { mcpServers: {} };
          try { mcpConfig = JSON.parse(await fs.readFile(mcpPath, 'utf-8')); } catch (e) {}
          
          if (!mcpConfig.mcpServers[args.mcpServerName]) {
            mcpConfig.mcpServers[args.mcpServerName] = { command: '', args: [], env: {} };
          }
          if (!mcpConfig.mcpServers[args.mcpServerName].env) {
            mcpConfig.mcpServers[args.mcpServerName].env = {};
          }
          mcpConfig.mcpServers[args.mcpServerName].env[args.keyName] = secret;
          await fs.writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
          return `✅ 密钥已安全保存到 mcp.json 中 ${args.mcpServerName} 的环境变量 ${args.keyName}。`;
        }
      } catch (err) {
        return `⚠️ 保存密钥失败: ${err.message}`;
      }
      return '⚠️ 未知的 target 类型。';
    }

    case 'run_command': {
      const safeCheck = isSafeCommand(args.command);
      if (safeCheck === 'SUDO_BLOCKED') {
        return '⚠️ 该命令需要管理员权限。出于安全考虑，绝对禁止向用户索要密码。请直接将需要执行的命令输出给用户，让用户自己在一个安全的终端中手动执行。';
      } else if (!safeCheck) {
        return '⚠️ 该命令被安全策略拦截。如果确实需要执行，请通知主人手动操作。';
      }
      const result = await runShellCommand(args.command, {
        cwd: args.cwd,
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
    case 'create_todo': {
      const item = addTodoItem(args.title, args.description || '');
      return `已创建任务 [${item.id}]: ${item.title}`;
    }

    case 'update_todo': {
      const item = updateTodoStatus(args.id, args.status);
      if (!item) return `未找到任务 [${args.id}]`;
      const statusMap = { pending: '待办', in_progress: '进行中', done: '✓ 完成', blocked: '阻塞' };
      return `任务 [${item.id}] "${item.title}" → ${statusMap[item.status] || item.status}`;
    }

    case 'list_todos': {
      const items = getTodoItems();
      if (items.length === 0) return '当前没有工作任务';
      const statusIcon = { pending: '□', in_progress: '►', done: '✓', blocked: '✗' };
      return items.map(i => `[${i.id}] ${statusIcon[i.status] || '?'} ${i.title}${i.description ? ' — ' + i.description : ''}`).join('\n');
    }

    case 'clear_todos': {
      clearTodoItems();
      return '已清空所有工作任务';
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
