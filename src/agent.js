import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { MIDOU_COMPANY_DIR } from '../midou.config.js';

export class Agent {
  constructor(id) {
    this.id = id;
    this.workspaceDir = path.join(MIDOU_COMPANY_DIR, 'agents', id);
    this.env = {};
    this.config = {};
  }

  async init() {
    // 确保目录存在
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'workspace'), { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'memory'), { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'skills'), { recursive: true });

    // 加载全局 .env
    dotenv.config({ path: path.join(MIDOU_COMPANY_DIR, '.env') });
    
    // 加载私有 .env
    const privateEnvPath = path.join(this.workspaceDir, '.env');
    try {
      const envConfig = dotenv.parse(await fs.readFile(privateEnvPath));
      for (const k in envConfig) {
        process.env[k] = envConfig[k];
      }
    } catch (e) {
      // 忽略不存在的私有 .env
    }

    // 加载私有 config.json
    const configPath = path.join(this.workspaceDir, 'config.json');
    try {
      this.config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    } catch (e) {
      this.config = {};
    }
  }
}
