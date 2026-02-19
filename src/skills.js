/**
 * 技能系统 — midou 的学习能力
 * 
 * 扫描 .claude/skills/ 和 ~/.midou/skills/ 目录，
 * 发现并加载技能描述，让 midou 知道自己有哪些扩展能力。
 * 
 * 技能通过 SKILL.md 文件定义，包含：
 * - 技能名称
 * - 技能描述
 * - 使用场景
 * - 详细指令（按需加载）
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import config from '../midou.config.js';

// 技能搜索路径
const SKILL_SEARCH_PATHS = [
  path.join(os.homedir(), '.claude', 'skills'),       // Claude 官方技能
  path.join(os.homedir(), '.agents', 'skills'),        // agents 技能
  path.join(config.workspace.root, 'skills'),          // midou 自定义技能
];

/**
 * 技能描述缓存
 */
let skillsCache = null;

/**
 * 发现所有可用技能
 * @returns {Array<{name, description, path, source}>}
 */
export async function discoverSkills() {
  if (skillsCache) return skillsCache;

  const skills = [];

  for (const searchPath of SKILL_SEARCH_PATHS) {
    try {
      const entries = await fs.readdir(searchPath, { withFileTypes: true });
      const source = searchPath.includes('.claude') ? 'claude'
        : searchPath.includes('.agents') ? 'agents'
        : 'midou';

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillMdPath = path.join(searchPath, entry.name, 'SKILL.md');
        try {
          await fs.access(skillMdPath);

          // 读取 SKILL.md 获取描述
          const content = await fs.readFile(skillMdPath, 'utf-8');
          const description = extractDescription(content);

          skills.push({
            name: entry.name,
            description,
            path: skillMdPath,
            source,
          });
        } catch {
          // SKILL.md 不存在，跳过
        }
      }
    } catch {
      // 目录不存在，跳过
    }
  }

  skillsCache = skills;
  return skills;
}

/**
 * 从 SKILL.md 内容中提取简短描述
 * 通常是 <description> 标签内的内容，或者第一段文字
 */
function extractDescription(content) {
  // 尝试提取 <description> 标签
  const descMatch = content.match(/<description>([\s\S]*?)<\/description>/);
  if (descMatch) {
    return descMatch[1].trim();
  }

  // 尝试提取 description 字段（YAML 风格）
  const yamlMatch = content.match(/description:\s*(.+)/i);
  if (yamlMatch) {
    return yamlMatch[1].trim();
  }

  // 回退：取第一段非标题文字
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('<') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 200);
    }
  }

  return '（无描述）';
}

/**
 * 读取技能的完整指令
 */
export async function loadSkillContent(skillName) {
  const skills = await discoverSkills();
  const skill = skills.find(s => s.name === skillName);
  if (!skill) return null;

  try {
    return await fs.readFile(skill.path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 构建技能部分的系统提示词
 */
export async function buildSkillsPrompt() {
  const skills = await discoverSkills();
  if (skills.length === 0) return '';

  const lines = ['你拥有以下技能，可以在需要时使用 `load_skill` 工具加载详细指令：\n'];

  for (const skill of skills) {
    lines.push(`- **${skill.name}** (${skill.source}): ${skill.description}`);
  }

  return lines.join('\n');
}

/**
 * 清除技能缓存（需要重新扫描时）
 */
export function clearSkillsCache() {
  skillsCache = null;
}

/**
 * 列出技能（用于工具调用）
 */
export async function listSkillNames() {
  const skills = await discoverSkills();
  return skills.map(s => `${s.name} (${s.source}): ${s.description}`);
}
