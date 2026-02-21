/**
 * 技能系统 — midou 的学习能力
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MIDOU_COMPANY_DIR } from '../midou.config.js';

// 技能搜索路径
const SKILL_SEARCH_PATHS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(MIDOU_COMPANY_DIR, 'skills'),
];

let skillsCache = null;

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

function extractDescription(content) {
  const descMatch = content.match(/<description>([\s\S]*?)<\/description>/);
  if (descMatch) return descMatch[1].trim();

  const yamlMatch = content.match(/description:\s*(.+)/i);
  if (yamlMatch) return yamlMatch[1].trim();

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('<') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 200);
    }
  }

  return '（无描述）';
}

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

export async function buildSkillsPrompt() {
  const skills = await discoverSkills();
  if (skills.length === 0) return '';

  const lines = ['你拥有以下技能，可以在需要时使用 `load_skill` 工具加载详细指令：\n'];
  for (const skill of skills) {
    lines.push(`- **${skill.name}** (${skill.source}): ${skill.description}`);
  }

  return lines.join('\n');
}

export function clearSkillsCache() {
  skillsCache = null;
}

export async function listSkillNames() {
  const skills = await discoverSkills();
  return skills.map(s => `${s.name} (${s.source}): ${s.description}`);
}
