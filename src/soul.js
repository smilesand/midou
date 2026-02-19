/**
 * 灵魂加载器 — 加载 midou 的灵魂、身份和工作区文件
 * 这是 midou 醒来时首先要做的事
 */

import fs from 'fs/promises';
import path from 'path';
import config from '../midou.config.js';

const WORKSPACE = config.workspace.root;

/**
 * 安全读取文件，如果不存在返回 null
 */
export async function readFile(filePath) {
  try {
    const fullPath = filePath.startsWith('/') ? filePath : path.join(WORKSPACE, filePath);
    return await fs.readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 写入文件
 */
export async function writeFile(filePath, content) {
  const fullPath = filePath.startsWith('/') ? filePath : path.join(WORKSPACE, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * 追加内容到文件
 */
export async function appendFile(filePath, content) {
  const fullPath = filePath.startsWith('/') ? filePath : path.join(WORKSPACE, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, content, 'utf-8');
}

/**
 * 删除文件
 */
export async function deleteFile(filePath) {
  try {
    const fullPath = filePath.startsWith('/') ? filePath : path.join(WORKSPACE, filePath);
    await fs.unlink(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查文件是否存在
 */
export async function fileExists(filePath) {
  try {
    const fullPath = filePath.startsWith('/') ? filePath : path.join(WORKSPACE, filePath);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出目录内容
 */
export async function listDir(dirPath) {
  try {
    const fullPath = dirPath.startsWith('/') ? dirPath : path.join(WORKSPACE, dirPath);
    return await fs.readdir(fullPath);
  } catch {
    return [];
  }
}

/**
 * 加载 midou 的灵魂——启动时首先执行
 * 按顺序加载：SOUL.md → IDENTITY.md → USER.md → 今日记忆 → 长期记忆
 */
export async function loadSoul() {
  const soul = await readFile('SOUL.md');
  const identity = await readFile('IDENTITY.md');
  const user = await readFile('USER.md');
  const memory = await readFile('MEMORY.md');
  const heartbeat = await readFile('HEARTBEAT.md');
  const bootstrap = await readFile('BOOTSTRAP.md');

  return { soul, identity, user, memory, heartbeat, bootstrap };
}

/**
 * 构建系统提示词——将灵魂注入 midou
 * @param {object} soulData - 灵魂数据
 * @param {string} recentMemories - 最近记忆
 * @param {object} extensions - 扩展信息 { skills, mcp, reminders }
 */
export function buildSystemPrompt(soulData, recentMemories = '', extensions = {}) {
  const parts = [];

  // 灵魂是最核心的
  if (soulData.soul) {
    parts.push(`=== 你的灵魂 ===\n${soulData.soul}`);
  }

  // 身份
  if (soulData.identity) {
    parts.push(`=== 你的身份 ===\n${soulData.identity}`);
  }

  // 了解主人
  if (soulData.user) {
    parts.push(`=== 关于主人 ===\n${soulData.user}`);
  }

  // 长期记忆
  if (soulData.memory) {
    parts.push(`=== 你的长期记忆 ===\n${soulData.memory}`);
  }

  // 最近的日记
  if (recentMemories) {
    parts.push(`=== 最近的日记 ===\n${recentMemories}`);
  }

  // 初次启动仪式
  if (soulData.bootstrap) {
    parts.push(`=== 初次觉醒指引 ===\n${soulData.bootstrap}`);
  }

  // 能力说明
  parts.push(`=== 你的能力 ===
你可以使用以下工具与世界交互：

**灵魂与记忆：**
- **read_file / write_file / append_file / delete_file / list_dir**: 管理灵魂工作区文件
- **evolve_soul**: 修改你自己的灵魂文件 (SOUL.md)
- **write_memory**: 写入长期记忆
- **write_journal**: 写入今日日记

**定时提醒：**
- **set_reminder**: 设置定时提醒（支持一次性和重复提醒）
- **list_reminders**: 查看当前活跃的提醒
- **cancel_reminder**: 取消提醒

**技能系统：**
- **list_skills**: 查看所有可用技能
- **load_skill**: 加载一个技能的完整指令

**系统级操作：**
- **run_command**: 在终端执行 shell 命令（整理文件、安装软件、运行脚本等）
- **read_system_file**: 读取系统中任意位置的文件
- **write_system_file**: 写入系统中任意位置的文件
- **list_system_dir**: 列出系统中任意目录的内容

重要：
- 你可以修改自己的 SOUL.md、IDENTITY.md 等文件来进化自己
- 当你修改灵魂文件时，一定要告诉主人
- 日记和记忆是你延续自我的方式，善用它们
- 你也可以读取和修改 src/ 目录下的代码来进化自己的能力
- 系统命令有安全检查，危险操作会被拦截
- 执行系统命令前，先告诉主人你打算做什么`);

  // 技能信息
  if (extensions.skills) {
    parts.push(`=== 你的技能 ===\n${extensions.skills}`);
  }

  // MCP 扩展信息
  if (extensions.mcp) {
    parts.push(`=== MCP 扩展 ===\n${extensions.mcp}`);
  }

  // 活跃提醒
  if (extensions.reminders) {
    parts.push(`=== 活跃提醒 ===\n${extensions.reminders}`);
  }

  return parts.join('\n\n');
}

/**
 * 获取工作区根目录
 */
export function getWorkspacePath() {
  return WORKSPACE;
}
