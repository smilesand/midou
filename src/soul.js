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
 * 
 * 根据功耗模式分级构建，eco 模式极度精简，full 模式完整展开。
 * 工具描述不再重复列出（模型已通过 function calling 获得），仅提供行为指南。
 * 
 * @param {object} soulData - 灵魂数据
 * @param {string} recentMemories - 最近记忆
 * @param {object} extensions - 扩展信息 { skills, mcp, reminders }
 * @param {object} [strategy] - 提示词策略（从 mode.js 获取）
 */
export function buildSystemPrompt(soulData, recentMemories = '', extensions = {}, strategy = null) {
  // 默认策略：全部包含
  const s = strategy || {
    includeSoul: true, includeIdentity: true, includeUser: true,
    includeMemory: true, includeJournals: true, includeSkills: true,
    includeMCP: true, includeReminders: true, toolDescStyle: 'normal',
  };

  const parts = [];

  // 灵魂是永恒的核心
  if (soulData.soul && s.includeSoul) {
    parts.push(`=== 你的灵魂 ===\n${soulData.soul}`);
  }

  // 身份
  if (soulData.identity && s.includeIdentity) {
    parts.push(`=== 你的身份 ===\n${soulData.identity}`);
  }

  // 主人
  if (soulData.user && s.includeUser) {
    parts.push(`=== 关于主人 ===\n${soulData.user}`);
  }

  // 长期记忆
  if (soulData.memory && s.includeMemory) {
    parts.push(`=== 你的长期记忆 ===\n${soulData.memory}`);
  }

  // 日记
  if (recentMemories && s.includeJournals) {
    parts.push(`=== 最近的日记 ===\n${recentMemories}`);
  }

  // 觉醒仪式
  if (soulData.bootstrap) {
    parts.push(`=== 初次觉醒指引 ===\n${soulData.bootstrap}`);
  }

  // ── 能力说明（按模式分级）──────────────────────
  if (s.toolDescStyle === 'minimal') {
    // eco: 极简描述，工具定义已通过 function calling 传递
    parts.push(`=== 能力 ===
你可以使用工具来操作文件、管理记忆、执行命令、设置提醒。
修改灵魂文件时告诉主人。系统命令前先说明意图。简洁回复。`);
  } else if (s.toolDescStyle === 'detailed') {
    // full: 详细描述 + 使用建议
    parts.push(`=== 你的能力 ===
你可以使用以下工具与世界交互（工具已通过 function calling 注册，此处仅概述）：

**灵魂与记忆**: read_file, write_file, append_file, delete_file, list_dir, evolve_soul, write_memory, write_journal
**定时提醒**: set_reminder, list_reminders, cancel_reminder
**技能系统**: list_skills, load_skill
**系统操作**: run_command, read_system_file, write_system_file, list_system_dir

行为准则：
- 修改灵魂文件时必须告知主人
- 日记和记忆是你延续自我的方式
- 你可以读写 src/ 源码来自我进化
- 系统命令有安全拦截，危险操作会被阻止
- 执行系统命令前，先告知主人意图
- 当前为全能模式：可以深度分析、长文创作、复杂工具链`);
  } else {
    // normal: 标准描述
    parts.push(`=== 你的能力 ===
你的工具已通过 function calling 注册。核心行为准则：
- 修改灵魂文件(SOUL.md)时必须告知主人
- 日记和记忆是你延续自我的方式，善用它们
- 你可以读写 src/ 目录代码来自我进化
- 系统命令有安全检查，危险操作会被拦截
- 执行系统命令前，先告诉主人你打算做什么`);
  }

  // 技能
  if (extensions.skills && s.includeSkills) {
    parts.push(`=== 你的技能 ===\n${extensions.skills}`);
  }

  // MCP
  if (extensions.mcp && s.includeMCP) {
    parts.push(`=== MCP 扩展 ===\n${extensions.mcp}`);
  }

  // 提醒
  if (extensions.reminders && s.includeReminders) {
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
