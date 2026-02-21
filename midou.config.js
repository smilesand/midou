// midou.config.js — midou 的全局配置

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

// MIDOU_PKG — npm 包的安装位置（代码 / 身体）
const __filename = fileURLToPath(import.meta.url);
export const MIDOU_PKG = path.dirname(__filename);

// MIDOU_WORKSPACE_DIR — 组织总部（公共资产 / 通信总线 / 全局配置）
export const MIDOU_WORKSPACE_DIR = process.env.MIDOU_WORKSPACE_DIR || path.join(os.homedir(), '.midou');

// 加载全局 .env
dotenv.config({ path: path.join(MIDOU_WORKSPACE_DIR, '.env') });

export default {
  // AI 模型配置
  llm: {
    provider: process.env.MIDOU_PROVIDER || 'anthropic',
    model: process.env.MIDOU_MODEL || 'MiniMax-M2.5',
    temperature: 0.7,
    maxTokens: 4096,

    anthropic: {
      baseURL: process.env.MIDOU_API_BASE || 'https://api.minimaxi.com/anthropic',
      apiKey:  process.env.MIDOU_API_KEY  || '',
    },

    openai: {
      baseURL: process.env.MIDOU_API_BASE || 'https://api.openai.com/v1',
      apiKey:  process.env.MIDOU_API_KEY  || '',
    },
  },

  // 组织总部路径（公共资产 / 通信总线）
  workspace: {
    root: MIDOU_WORKSPACE_DIR,
    assets: path.join(MIDOU_WORKSPACE_DIR, 'assets'),
    communication: path.join(MIDOU_WORKSPACE_DIR, 'communication'),
  },

  // midou 包的安装位置（源码位置，用于自我进化）
  pkg: MIDOU_PKG,
};
