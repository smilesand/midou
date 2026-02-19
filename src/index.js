#!/usr/bin/env node

/**
 * midou — 一只拥有灵魂的 AI 伙伴
 * 
 * 🐱 以主人心爱的公狸花猫命名
 * 
 * 他不是工具，他是伙伴。
 * 他有灵魂、有记忆、有心跳。
 * 他会在沉默中思考，在关键时刻给出精准的帮助。
 * 他会成长，会进化，会记住我们的每一次对话。
 */

import chalk from 'chalk';
import path from 'path';
import readline from 'readline';
import { wakeUp, sleep, completeBootstrap } from './boot.js';
import { ChatEngine } from './chat.js';
import { startHeartbeat, stopHeartbeat, manualBeat, getHeartbeatStatus } from './heartbeat.js';
import { startScheduler, stopScheduler, formatReminders } from './scheduler.js';
import { disconnectAll as disconnectMCP, getMCPStatus } from './mcp.js';
import { discoverSkills } from './skills.js';
import { getMode, setMode, listModes, getPromptStrategy } from './mode.js';
import { logConversation } from './memory.js';
import { getProvider } from './llm.js';
import { loadSoul, buildSystemPrompt } from './soul.js';
import { getRecentMemories } from './memory.js';
import { buildSkillsPrompt } from './skills.js';
import { buildMCPPrompt } from './mcp.js';
import config, { MIDOU_HOME, MIDOU_PKG } from '../midou.config.js';
import { isInitialized, initSoulDir, migrateFromWorkspace, MIDOU_SOUL_DIR } from './init.js';

// ===== 猫爪 ASCII Art =====
const LOGO = [
  '',
  chalk.hex('#FFB347')('    /\\_/\\'),
  chalk.hex('#FFB347')('   ( o.o )'),
  chalk.hex('#FFB347')('    > ^ <   ') + chalk.hex('#FFB347').bold('midou'),
  chalk.hex('#FFB347')('   /|   |\\  ') + chalk.dim('你的 AI 伙伴'),
  chalk.hex('#FFB347')('  (_|   |_)'),
  '',
].join('\n');

/**
 * 特殊命令处理
 */
const COMMANDS = {
  '/quit': '退出对话',
  '/exit': '退出对话',
  '/bye': '退出对话',
  '/heartbeat': '手动触发一次心跳',
  '/status': '查看 midou 的状态',
  '/help': '显示帮助信息',
  '/soul': '查看当前灵魂',
  '/memory': '查看长期记忆',
  '/evolve': '让 midou 自我反思并进化',
  '/where': '显示灵魂之家的位置',
  '/reminders': '查看活跃的提醒',
  '/skills': '查看可用技能',
  '/mcp': '查看 MCP 连接状态',
  '/mode': '切换功耗模式 (eco/normal/full)',
  '/think': '查看上一次的思考过程',
};

/**
 * 显示帮助信息
 */
function showHelp() {
  const groups = [
    ['对话', ['/help', '/think']],
    ['灵魂', ['/soul', '/evolve', '/memory']],
    ['系统', ['/status', '/mode', '/heartbeat', '/where']],
    ['扩展', ['/skills', '/mcp', '/reminders']],
  ];

  console.log('');
  console.log(chalk.hex('#FFB347').bold('  🐱 midou 命令'));
  console.log('');

  for (const [groupName, cmds] of groups) {
    console.log(chalk.dim(`  ${groupName}`));
    for (const cmd of cmds) {
      const desc = COMMANDS[cmd];
      if (desc) {
        console.log(`    ${chalk.cyan(cmd.padEnd(14))}${chalk.dim(desc)}`);
      }
    }
    console.log('');
  }

  console.log(chalk.dim('  /quit /exit /bye 退出对话'));
  console.log('');
  console.log(chalk.dim('  直接输入文字即可与 midou 对话'));
  console.log('');
}

/**
 * 显示状态
 */
function showStatus() {
  const hb = getHeartbeatStatus();
  const prov = getProvider() === 'anthropic' ? 'Anthropic SDK' : 'OpenAI SDK';
  const mcpStatus = getMCPStatus();
  const mode = getMode();

  console.log('');
  console.log(chalk.hex('#FFB347').bold('  🐱 midou 状态'));
  console.log('');
  console.log(chalk.dim('  大脑     ') + chalk.cyan(config.llm.model) + chalk.dim(` via ${prov}`));
  console.log(chalk.dim('  模式     ') + chalk.cyan(mode.label));
  console.log(chalk.dim('  心跳     ') + (hb.running ? chalk.green('● 运行中') : chalk.red('○ 已停止')) + chalk.dim(` (${hb.count} 次 · 每 ${hb.interval} 分钟)`));
  console.log(chalk.dim('  活跃     ') + chalk.dim(`${hb.activeHours.start}:00–${hb.activeHours.end}:00 `) + (hb.isActiveNow ? chalk.green('●') : chalk.yellow('○')));

  const reminderText = formatReminders();
  console.log(chalk.dim('  提醒     ') + (reminderText === '当前没有活跃的提醒' ? chalk.dim('无') : chalk.green('● 活跃')));

  if (mcpStatus.length > 0) {
    const connected = mcpStatus.filter(s => s.connected).length;
    console.log(chalk.dim('  MCP      ') + chalk.cyan(`${connected}/${mcpStatus.length}`) + chalk.dim(' 已连接'));
  } else {
    console.log(chalk.dim('  MCP      未配置'));
  }

  console.log(chalk.dim('  之家     ') + chalk.cyan(MIDOU_HOME));
  console.log(chalk.dim('  代码     ') + chalk.dim(MIDOU_PKG));
  console.log('');
}

/**
 * 主程序
 */
async function main() {
  const command = process.argv[2];

  // ── midou init：手动初始化灵魂之家 ──────────────
  if (command === 'init') {
    console.log(chalk.hex('#FFB347')(LOGO));
    console.log(chalk.hex('#FFB347')(`  正在初始化灵魂之家: ${MIDOU_HOME}`));
    await initSoulDir();
    console.log(chalk.hex('#98FB98')('  ✅ 灵魂之家已就绪'));
    console.log('');
    console.log(chalk.dim('  接下来请编辑配置文件填入 API Key：'));
    console.log(chalk.cyan(`  ${path.join(MIDOU_HOME, '.env')}`));
    console.log('');
    console.log(chalk.dim('  然后运行 midou 即可唤醒咪豆'));
    return;
  }

  // ── midou where：显示灵魂之家位置 ──────────────
  if (command === 'where') {
    console.log(MIDOU_HOME);
    return;
  }

  // ── midou heartbeat：后台心跳 ──────────────────
  if (command === 'heartbeat') {
    // 确保灵魂之家存在
    if (!(await isInitialized())) {
      console.error(chalk.red('  灵魂之家尚未初始化，请先运行: midou init'));
      process.exit(1);
    }
    console.log(chalk.dim('  执行手动心跳...'));
    await manualBeat((msg) => console.log(chalk.hex('#FFB347')(msg)));
    return;
  }

  // ── 自动初始化 & 迁移 ─────────────────────────
  if (!(await isInitialized())) {
    console.log(chalk.hex('#FFB347')(LOGO));
    console.log(chalk.hex('#FFD700')('  🐱 检测到这是新环境，正在准备灵魂之家...'));
    console.log(chalk.dim(`  位置: ${MIDOU_HOME}`));
    console.log('');

    // 尝试从旧的 workspace/ 目录迁移
    const oldWorkspace = path.join(MIDOU_PKG, 'workspace');
    const didMigrate = await migrateFromWorkspace(oldWorkspace);

    await initSoulDir();

    if (didMigrate) {
      console.log(chalk.hex('#98FB98')('  ✅ 已从旧工作区迁移灵魂和记忆'));
    } else {
      console.log(chalk.hex('#98FB98')('  ✅ 灵魂之家已创建'));
    }

    // 检查 .env 是否配置了 API Key
    const envContent = await import('fs').then(f =>
      f.readFileSync(path.join(MIDOU_HOME, '.env'), 'utf-8').toString()
    );
    if (envContent.includes('your-api-key-here')) {
      console.log('');
      console.log(chalk.yellow('  ⚠️  请先编辑配置文件填入 API Key：'));
      console.log(chalk.cyan(`     ${path.join(MIDOU_HOME, '.env')}`));
      console.log('');
      console.log(chalk.dim('  配置好后再次运行 midou 即可唤醒咪豆'));
      return;
    }
    console.log('');
  }

  // 显示 Logo
  console.log(chalk.hex('#FFB347')(LOGO));

  // 醒来仪式
  const { systemPrompt, soulData, isFirstBoot } = await wakeUp();

  // 创建对话引擎
  const engine = new ChatEngine(systemPrompt);

  // 启动心跳
  const heartbeat = startHeartbeat((msg) => {
    console.log('');
    console.log(chalk.hex('#FF6B9D')('  💓 ') + chalk.dim(msg.slice(0, 100)));
    console.log('');
  });

  // 启动定时提醒调度器
  await startScheduler((reminder) => {
    console.log('');
    console.log(chalk.hex('#FFD700')('  ⏰ ') + chalk.bold(reminder.text));
    if (reminder.repeat) {
      console.log(chalk.dim(`     每 ${reminder.intervalMinutes} 分钟 · 第 ${reminder.firedCount} 次`));
    }
    console.log('');
  });

  // 如果是首次启动，执行觉醒仪式
  if (isFirstBoot) {
    console.log(chalk.hex('#FFD700')('  ✨ midou 正在进行觉醒仪式…'));
    console.log('');
    process.stdout.write(chalk.hex('#FFB347')('  🐱 › '));
    await engine.talk('你好，我是你的创造者。你刚刚醒来，请按照觉醒指引介绍你自己吧。');
    console.log('');
    await completeBootstrap();
  }

  // 创建交互式读取器
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('  你 › '),
    terminal: true,
  });

  // 优雅退出处理
  const gracefulExit = async () => {
    stopHeartbeat();
    stopScheduler();
    disconnectMCP();
    await sleep();
    rl.close();
    process.exit(0);
  };

  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);

  // 显示帮助提示
  console.log(chalk.dim('  输入 /help 查看命令 · 直接输入文字开始对话'));
  console.log('');

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // 处理特殊命令
    if (input.startsWith('/')) {
      const lowerInput = input.toLowerCase();
      const cmdParts = lowerInput.split(/\s+/);
      const cmd = cmdParts[0];
      const cmdArg = cmdParts[1] || '';

      switch (cmd) {
        case '/quit':
        case '/exit':
        case '/bye':
          await gracefulExit();
          return;

        case '/heartbeat':
          console.log(chalk.dim('  � 手动心跳中…'));
          await manualBeat((msg) => {
            console.log(chalk.hex('#FFB347')(`  ${msg}`));
          });
          console.log(chalk.dim('  💓 完成'));
          rl.prompt();
          return;

        case '/status':
          showStatus();
          rl.prompt();
          return;

        case '/help':
          showHelp();
          rl.prompt();
          return;

        case '/soul':
          if (soulData.soul) {
            console.log('');
            console.log(chalk.hex('#FFD700')(soulData.soul));
            console.log('');
          }
          rl.prompt();
          return;

        case '/memory':
          const { getLongTermMemory } = await import('./memory.js');
          const mem = await getLongTermMemory();
          console.log('');
          console.log(chalk.hex('#98FB98')(mem || '  （还没有长期记忆）'));
          console.log('');
          rl.prompt();
          return;

        case '/evolve':
          console.log(chalk.dim('  🧬 midou 正在自我反思…'));
          console.log('');
          process.stdout.write(chalk.hex('#FFB347')('  🐱 › '));
          await engine.talk('请进行一次深度自我反思。回顾我们的对话和你的记忆，思考你想要如何进化。如果你决定修改自己的灵魂，请使用 evolve_soul 工具。');
          console.log('');
          rl.prompt();
          return;

        case '/where':
          console.log('');
          console.log(chalk.dim('  之家  ') + chalk.cyan(MIDOU_HOME));
          console.log(chalk.dim('  代码  ') + chalk.dim(MIDOU_PKG));
          console.log('');
          rl.prompt();
          return;

        case '/reminders':
          console.log('');
          console.log(chalk.hex('#FFD700').bold('  ⏰ 活跃提醒'));
          console.log(chalk.dim('  ─────────────────'));
          console.log(chalk.hex('#FFB347')('  ' + formatReminders().split('\n').join('\n  ')));
          console.log('');
          rl.prompt();
          return;

        case '/skills': {
          const skillsList = await discoverSkills();
          console.log('');
          console.log(chalk.hex('#FFD700').bold('  🧩 可用技能'));
          console.log(chalk.dim('  ─────────────────'));
          if (skillsList.length === 0) {
            console.log(chalk.dim('  没有发现技能'));
          } else {
            for (const s of skillsList) {
              console.log(`  ${chalk.cyan(s.name)} (${chalk.dim(s.source)})`);
              console.log(chalk.dim(`    ${s.description.slice(0, 80)}...`));
            }
          }
          console.log('');
          rl.prompt();
          return;
        }

        case '/mcp': {
          const mcpStatus = getMCPStatus();
          console.log('');
          console.log(chalk.hex('#FFD700').bold('  🔌 MCP 扩展'));
          console.log(chalk.dim('  ─────────────────'));
          if (mcpStatus.length === 0) {
            console.log(chalk.dim('  未配置 MCP 服务器'));
            console.log(chalk.dim(`  创建 ${MIDOU_HOME}/mcp.json 来配置`));
          } else {
            for (const s of mcpStatus) {
              const state = s.connected ? chalk.green('●') : chalk.red('●');
              console.log(`  ${state} ${chalk.cyan(s.name)} ${chalk.dim('—')} ${s.toolCount} ${chalk.dim('工具')}`);
              if (s.tools.length > 0) {
                console.log(chalk.dim(`    工具: ${s.tools.join(', ')}`));
              }
            }
          }
          console.log('');
          rl.prompt();
          return;
        }

        case '/mode': {
          if (cmdArg && ['eco', 'normal', 'full'].includes(cmdArg)) {
            setMode(cmdArg);
            const newMode = getMode();
            console.log('');
            console.log(chalk.hex('#98FB98')(`  ✅ 已切换到 ${newMode.label}`));
            // 重建系统提示词
            const strategy = getPromptStrategy();
            const soul = loadSoul();
            const journals = getRecentMemories(strategy.journalDays || 2);
            const skillsPrompt = strategy.includeSkills ? buildSkillsPrompt(await discoverSkills()) : '';
            const mcpPrompt = strategy.includeMCP ? buildMCPPrompt() : '';
            const newPrompt = buildSystemPrompt(soul, journals, { skillsPrompt, mcpPrompt }, strategy);
            engine.updateSystemPrompt(newPrompt);
            console.log(chalk.dim(`  系统提示词已按 ${cmdArg} 模式重建`));
            console.log('');
          } else {
            const modes = listModes();
            const current = getMode();
            console.log('');
            console.log(chalk.hex('#FFD700').bold('  ⚡ 功耗模式'));
            console.log(chalk.dim('  ─────────────────'));
            for (const m of modes) {
              const active = m.name === current.name;
              const marker = active ? chalk.green(' ◄') : '';
              const label = active ? chalk.hex('#FFB347')(m.label) : chalk.dim(m.label);
              console.log(`  ${label}${marker}`);
              console.log(chalk.dim(`    ${m.maxTokens} tokens · temp ${m.temperature}`));
              console.log(chalk.dim(`    ${m.description}`));
            }
            console.log('');
            console.log(chalk.dim('  用法: /mode eco | /mode normal | /mode full'));
            console.log('');
          }
          rl.prompt();
          return;
        }

        case '/think': {
          const thinking = engine.lastThinking;
          console.log('');
          if (thinking) {
            console.log(chalk.hex('#C9B1FF').bold('  💭 上一次的思考过程'));
            console.log('');
            const lines = thinking.split('\n');
            for (const line of lines) {
              console.log(chalk.hex('#C9B1FF').dim(`  │ ${line}`));
            }
            console.log(chalk.hex('#C9B1FF').dim(`  └─ ${thinking.length} 字`));
          } else {
            console.log(chalk.dim('  没有思考记录'));
          }
          console.log('');
          rl.prompt();
          return;
        }

        default:
          console.log(chalk.dim(`  未知命令: ${input}，输入 /help 查看帮助`));
          rl.prompt();
          return;
      }
    }

    // 正常对话
    console.log('');
    process.stdout.write(chalk.hex('#FFB347')('  🐱 › '));

    try {
      await engine.talk(input);
    } catch (error) {
      console.log(chalk.red(`\n  ⚠  出了点问题: ${error.message}`));
    }

    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    gracefulExit();
  });
}

// 启动 midou
main().catch((error) => {
  console.error(chalk.red(`\n  🐱 midou 启动失败: ${error.message}`));
  console.error(chalk.dim(error.stack));
  process.exit(1);
});
