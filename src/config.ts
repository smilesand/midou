// src/config.ts — midou 的全局配置

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import type { MidouAppConfig } from './types.js';

// MIDOU_PKG — npm 包的安装位置（代码 / 身体）
const __filename = fileURLToPath(import.meta.url);
export const MIDOU_PKG = path.dirname(path.dirname(__filename));

// MIDOU_WORKSPACE_DIR — 组织总部（公共资产 / 全局配置）
export const MIDOU_WORKSPACE_DIR: string =
  process.env.MIDOU_WORKSPACE_DIR || path.join(os.homedir(), '.midou');

// 加载全局 .env
dotenv.config({ path: path.join(MIDOU_WORKSPACE_DIR, '.env') });

// MIDOU_PLUGINS_PATH — 插件目录（默认指向当前项目内置 workspace/plugins）
export const MIDOU_PLUGINS_PATH: string =
  process.env.MIDOU_PLUGINS_PATH
    ? path.resolve(process.env.MIDOU_PLUGINS_PATH)
    : path.join(MIDOU_PKG, 'workspace', 'plugins');

const config: MidouAppConfig = {
  llm: {
    provider: process.env.MIDOU_PROVIDER || 'anthropic',
    model: process.env.MIDOU_MODEL || 'MiniMax-M2.5',
    temperature: 0.7,
    maxTokens: 4096,
    apiKey: process.env.MIDOU_API_KEY || '',
    apiBase: process.env.MIDOU_API_BASE || '',
  },

  workspace: {
    root: MIDOU_WORKSPACE_DIR,
    assets: path.join(MIDOU_WORKSPACE_DIR, 'assets'),
    plugins: MIDOU_PLUGINS_PATH,
  },

  pkg: MIDOU_PKG,
};

export default config;
