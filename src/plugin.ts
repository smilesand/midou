/**
 * 插件系统 — 扫描并加载 workspace/plugins 中的插件
 *
 * 插件可以注册工具和记忆提供者，扩展系统能力。
 */

import path from 'path';
import fs from 'fs/promises';
import { MIDOU_PLUGINS_PATH, MIDOU_WORKSPACE_DIR } from './config.js';
import { registerTool } from './tools.js';
import { memoryManager } from './memory.js';
import { quickAsk, createLLMWrapper } from './llm.js';
import type {
  Plugin,
  PluginContext,
  SystemManagerInterface,
  MemoryProvider,
  LLMConfig,
} from './types.js';
import type { Express } from 'express';

const PLUGINS_DIR = MIDOU_PLUGINS_PATH;

/**
 * 扫描并加载所有插件
 */
export async function loadPlugins(
  systemManager: SystemManagerInterface,
  app: Express
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(PLUGINS_DIR);
  } catch {
    console.log('[Plugin] 插件目录不存在或无法访问:', PLUGINS_DIR);
    return;
  }

  for (const entry of entries) {
    const pluginDir = path.join(PLUGINS_DIR, entry);
    const stat = await fs.stat(pluginDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    // 按优先级查找入口文件: index.ts > index.js
    let indexPath: string | null = null;
    for (const ext of ['index.ts', 'index.js']) {
      const candidate = path.join(pluginDir, ext);
      try {
        await fs.access(candidate);
        indexPath = candidate;
        break;
      } catch {
        // 继续尝试下一个
      }
    }
    if (!indexPath) continue;

    try {
      const mod = await import(indexPath);
      const plugin: Plugin = mod.default || mod;

      if (!plugin.install) {
        console.warn(`[Plugin] ${entry}: 缺少 install 方法，跳过`);
        continue;
      }

      // 构建插件上下文（含 LLM 依赖注入）
      const context: PluginContext = {
        systemManager,
        app,
        registerTool: (definition, handler) => {
          console.log(`[Plugin] ${entry}: 注册工具 ${definition.function.name}`);
          registerTool(definition, handler);
        },
        registerMemoryProvider: (provider: MemoryProvider) => {
          console.log(`[Plugin] ${entry}: 注册记忆提供者 ${provider.name}`);
          memoryManager.register(provider);
          // 异步初始化
          provider.init().catch((err) => {
            console.error(`[Plugin] ${entry}: 记忆提供者 ${provider.name} 初始化失败:`, err);
          });
        },
        // LLM 依赖注入
        createLLM: (options?: LLMConfig) => createLLMWrapper(options),
        quickAsk,
        // 配置信息
        workspaceDir: MIDOU_WORKSPACE_DIR,
      };

      await plugin.install(context);
      console.log(`[Plugin] ✓ 已加载: ${plugin.name || entry}`);
    } catch (err) {
      console.error(`[Plugin] ✗ 加载失败: ${entry}`, err);
    }
  }
}
