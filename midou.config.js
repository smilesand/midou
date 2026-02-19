// midou.config.js — midou 的全局配置
// 你可以根据需要修改这些配置

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

// MIDOU_PKG — npm 包的安装位置（代码 / 身体）
const __filename = fileURLToPath(import.meta.url);
export const MIDOU_PKG = path.dirname(__filename);

// MIDOU_HOME — 灵魂之家（灵魂 / 记忆 / 配置）
// 默认 ~/.midou/，可通过 MIDOU_SOUL_DIR 环境变量自定义
export const MIDOU_HOME = process.env.MIDOU_SOUL_DIR || path.join(os.homedir(), '.midou');

// 先从灵魂之家加载 .env，再读取 process.env
dotenv.config({ path: path.join(MIDOU_HOME, '.env') });

export default {
  // AI 模型配置
  llm: {
    // ── 提供商选择 ──────────────────────────────────────
    // 'anthropic' → Anthropic SDK（适用于 Claude / MiniMax）
    // 'openai'    → OpenAI SDK （适用于 OpenAI / DeepSeek / Moonshot / 智谱 / Ollama …）
    provider: process.env.MIDOU_PROVIDER || 'anthropic',

    // 当前使用的模型名称
    model: process.env.MIDOU_MODEL || 'MiniMax-M2.5',

    // 通用参数
    temperature: 0.7,
    maxTokens: 4096,

    // ── Anthropic SDK 配置 ─────────────────────────────
    anthropic: {
      baseURL: process.env.MIDOU_API_BASE || 'https://api.minimaxi.com/anthropic',
      apiKey:  process.env.MIDOU_API_KEY  || '',
    },

    // ── OpenAI SDK 配置 ────────────────────────────────
    openai: {
      baseURL: process.env.MIDOU_API_BASE || 'https://api.openai.com/v1',
      apiKey:  process.env.MIDOU_API_KEY  || '',
    },
  },

  // 心跳配置
  heartbeat: {
    enabled: true,
    intervalMinutes: 30, // 每 30 分钟一次心跳
    activeHours: {
      start: 8,  // 早上 8 点开始
      end: 22,   // 晚上 10 点结束
    },
  },

  // 记忆配置
  memory: {
    // 每日日记的最大保留天数（0 = 永久）
    maxDailyDays: 0,
    // 上下文接近限制时自动保存记忆
    autoFlush: true,
  },

  // 工作区路径（灵魂之家）
  workspace: {
    root: MIDOU_HOME,
  },

  // midou 包的安装位置（源码位置，用于自我进化）
  pkg: MIDOU_PKG,

  // midou 的灵魂之家路径
  home: MIDOU_HOME,
};
