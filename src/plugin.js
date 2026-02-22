import fs from 'fs/promises';
import path from 'path';
import { registerTool } from './tools.js';
import { MIDOU_WORKSPACE_DIR } from '../midou.config.js';

export async function loadPlugins(systemManager, app) {
  const pluginsDir = path.join(MIDOU_WORKSPACE_DIR, 'plugins');
  
  try {
    await fs.mkdir(pluginsDir, { recursive: true });
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = path.join(pluginsDir, entry.name, 'index.js');
        try {
          await fs.access(pluginPath);
          const pluginUrl = 'file://' + path.resolve(pluginPath);
          console.log(`[Plugin] Attempting to load from: ${pluginUrl}`);
          const module = await import(pluginUrl);
          const plugin = module.default || module;
          
          if (plugin && typeof plugin.install === 'function') {
            console.log(`[Plugin] Loading plugin: ${plugin.name || entry.name}`);
            await plugin.install({ systemManager, app, registerTool });
            console.log(`[Plugin] Successfully loaded: ${plugin.name || entry.name}`);
          } else if (typeof module.install === 'function') {
            console.log(`[Plugin] Loading plugin: ${entry.name}`);
            await module.install({ systemManager, app, registerTool });
            console.log(`[Plugin] Successfully loaded: ${entry.name}`);
          } else {
            console.warn(`[Plugin] Plugin ${entry.name} does not export an install function. Module keys: ${Object.keys(module).join(', ')}`);
          }
        } catch (err) {
          console.error(`[Plugin] Failed to load plugin ${entry.name}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Plugin] Error reading plugins directory:', err);
  }
}
