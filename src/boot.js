/**
 * 启动系统 — midou 醒来的仪式
 * 
 * 每次启动时：
 * 1. 加载灵魂 (SOUL.md)
 * 2. 加载身份 (IDENTITY.md)  
 * 3. 加载主人信息 (USER.md)
 * 4. 加载最近的日记
 * 5. 加载长期记忆
 * 6. 发现技能
 * 7. 连接 MCP 服务器
 * 8. 加载定时提醒
 * 9. 如果是第一次，执行 BOOTSTRAP 仪式
 */

import chalk from 'chalk';
import dayjs from 'dayjs';
import { loadSoul, buildSystemPrompt, fileExists, deleteFile } from './soul.js';
import { getRecentMemories, writeJournal } from './memory.js';
import { initLLM, getProvider } from './llm.js';
import { buildSkillsPrompt, discoverSkills } from './skills.js';
import { connectMCPServers, hasMCPConfig, buildMCPPrompt } from './mcp.js';
import { formatReminders } from './scheduler.js';
import { initMode, getPromptStrategy } from './mode.js';
import config, { MIDOU_AGENT_DIR } from '../midou.config.js';

/**
 * midou 醒来
 */
export async function wakeUp() {
  const now = dayjs().format('YYYY-MM-DD HH:mm');

  console.log('');
  console.log(chalk.hex('#FFB347')('  🐱 midou 正在醒来…'));
  console.log(chalk.dim(`  ${now}`));
  console.log('');

  // 初始化功耗模式
  const mode = initMode();
  const strategy = getPromptStrategy();

  // 初始化 LLM
  try {
    initLLM();
  } catch (error) {
    console.error(chalk.red(error.message));
    process.exit(1);
  }

  // 加载灵魂
  const soulData = await loadSoul();

  if (!soulData.soul) {
    console.error(chalk.red('  找不到 SOUL.md —— midou 没有灵魂！'));
    process.exit(1);
  }

  // 检查是否为首次启动
  const isFirstBoot = await fileExists('BOOTSTRAP.md');

  // 加载最近记忆（天数由模式决定）
  const recentMemories = await getRecentMemories(strategy.journalDays || 2);

  // ── 发现技能（模式允许时）──
  let skills = [];
  let skillsPrompt = '';
  if (strategy.includeSkills) {
    skills = await discoverSkills();
    skillsPrompt = await buildSkillsPrompt();
    if (skills.length > 0) {
      console.log(chalk.dim('  ▸ ') + chalk.hex('#98FB98')(`发现 ${skills.length} 个技能`));
    }
  }

  // ── 连接 MCP 服务器（模式允许时）──
  let mcpPrompt = '';
  if (strategy.includeMCP && await hasMCPConfig()) {
    console.log(chalk.dim('  ▸ 正在连接 MCP 服务器…'));
    const results = await connectMCPServers();
    for (const r of results) {
      if (r.status === 'connected') {
        console.log(chalk.dim('    ') + chalk.green('●') + chalk.dim(` ${r.name} (${r.tools.length} 工具)`));
      } else {
        console.log(chalk.dim('    ') + chalk.red('●') + chalk.dim(` ${r.name}`) + chalk.yellow(' 失败'));
      }
    }
    mcpPrompt = buildMCPPrompt();
  }

  // ── 活跃提醒 ──
  const remindersText = formatReminders();

  // 构建系统提示（包含扩展信息，使用模式策略）
  const systemPrompt = buildSystemPrompt(soulData, recentMemories, {
    skills: skillsPrompt || undefined,
    mcp: mcpPrompt || undefined,
    reminders: remindersText !== '当前没有活跃的提醒' ? remindersText : undefined,
  }, strategy);

  // 记录醒来
  await writeJournal(`### ${dayjs().format('HH:mm')} [醒来]\n\nmidou 在 ${now} 醒来了。${isFirstBoot ? '这是第一次觉醒。' : ''}${skills.length > 0 ? ` 发现 ${skills.length} 个技能。` : ''}\n`);

  const providerLabel = getProvider() === 'anthropic' ? 'Anthropic SDK' : 'OpenAI SDK';
  const W = Math.min(process.stdout.columns || 48, 48);
  const ruler = chalk.dim('  ' + '─'.repeat(W));
  console.log(ruler);
  console.log(chalk.dim('  大脑  ') + chalk.cyan(`${config.llm.model}`) + chalk.dim(` via ${providerLabel}`));
  console.log(chalk.dim('  模式  ') + chalk.cyan(mode.label));
  console.log(chalk.dim('  之家  ') + chalk.cyan(MIDOU_AGENT_DIR));
  console.log(ruler);
  console.log('');

  if (isFirstBoot) {
    console.log(chalk.hex('#FFD700')('  ✨ 这是 midou 的第一次觉醒！'));
    console.log('');
  } else {
    console.log(chalk.hex('#98FB98')('  ✦ midou 准备好了'));
    console.log('');
  }

  return {
    systemPrompt,
    soulData,
    isFirstBoot,
    recentMemories,
  };
}

/**
 * 完成首次启动仪式——删除 BOOTSTRAP.md
 */
export async function completeBootstrap() {
  await deleteFile('BOOTSTRAP.md');
}

/**
 * midou 入睡（优雅退出）
 */
export async function sleep() {
  const now = dayjs().format('HH:mm');
  await writeJournal(`### ${now} [入睡]\n\nmidou 在 ${now} 入睡了。晚安。\n`);

  console.log('');
  console.log(chalk.hex('#FFB347')('  🐱 midou 入睡了…晚安'));
  console.log('');
}
