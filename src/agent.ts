/**
 * Agent — midou 的智能体抽象层
 *
 * 每个 Agent 拥有独立的身份、记忆、工具集和对话引擎。
 * Agent 是系统中的基本工作单元，可以独立运行或协作完成任务。
 */

import path from 'path';
import fs from 'fs/promises';
import { ChatEngine } from './chat.js';
import { loadHistoryFromJournal } from './memory.js';
import { MIDOU_WORKSPACE_DIR } from './config.js';
import type {
  AgentConfig,
  AgentData,
  AgentInterface,
  ChatEngineInterface,
  OutputHandler,
  SystemManagerInterface,
} from './types.js';

// ── 默认输出处理器 ──

function createConsoleOutputHandler(agentName: string): OutputHandler {
  let textBuffer = '';
  return {
    onThinkingStart: () => {},
    onThinkingDelta: () => {},
    onThinkingEnd: () => {},
    onThinkingHidden: () => {},
    onTextDelta: (text: string) => {
      textBuffer += text;
    },
    onTextPartComplete: () => {
      if (textBuffer) {
        console.log(`[${agentName}] ${textBuffer}`);
        textBuffer = '';
      }
    },
    onTextComplete: () => {},
    onToolStart: (name: string) => {
      console.log(`[${agentName}] 🔧 ${name}...`);
    },
    onToolEnd: (name: string) => {
      console.log(`[${agentName}] ✓ ${name} 完成`);
    },
    onToolExec: () => {},
    onToolResult: () => {},
    onError: (msg: string) => {
      console.error(`[${agentName}] ❌ ${msg}`);
    },
    confirmCommand: async () => true,
  };
}

/**
 * Agent 类
 */
export class Agent implements AgentInterface {
  id: string;
  name: string;
  config: AgentData;
  position?: { x: number; y: number };
  workspaceDir: string;
  engine: ChatEngineInterface | null;
  isBusy: boolean;

  private _messageQueue: Array<{ from: string; content: string; ts: number }>;
  private _systemManager: SystemManagerInterface | null;

  constructor(
    agentConfig: AgentConfig,
    systemManager: SystemManagerInterface | null = null
  ) {
    this.id = agentConfig.id;
    this.name = agentConfig.name;
    this.config = agentConfig.data || agentConfig.config || {};
    this.position = agentConfig.position;
    this.workspaceDir = path.join(MIDOU_WORKSPACE_DIR, 'agents', this.id);
    this.engine = null;
    this.isBusy = false;
    this._messageQueue = [];
    this._systemManager = systemManager;
  }

  /**
   * 初始化 Agent — 创建工作目录和对话引擎
   */
  async init(): Promise<void> {
    // 确保工作目录
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'memory'), { recursive: true });

    // 创建对话引擎
    this.engine = new ChatEngine(
      this.id,
      this.name,
      this.config,
      this._systemManager
    );

    // 设置默认输出处理器
    this.engine.setOutputHandler(createConsoleOutputHandler(this.name));

    // 从日志恢复历史对话（服务重启后可在前端展示）
    try {
      const history = await loadHistoryFromJournal(this.name, 30, 1);
      if (history.length > 0) {
        for (const msg of history) {
          this.engine.session.add(msg);
        }
        console.log(`[Agent] ${this.name} 已从日志恢复 ${history.length} 条历史消息`);
      }
    } catch (err) {
      console.warn(`[Agent] ${this.name} 恢复历史消息失败:`, err);
    }

    console.log(`[Agent] ${this.name} (${this.id}) 已初始化`);
  }

  /**
   * 处理消息 — 入口点
   */
  async talk(message: string): Promise<void> {
    if (!this.engine) {
      await this.init();
    }

    if (this.isBusy) {
      this._messageQueue.push({
        from: 'user',
        content: message,
        ts: Date.now(),
      });
      console.log(`[Agent] ${this.name} 正忙，消息已加入队列`);
      return;
    }

    this.isBusy = true;
    try {
      // 检查消息队列中的累积消息
      const queuedMessages = this._drainQueue();
      let fullMessage = message;
      if (queuedMessages.length > 0) {
        const queuedText = queuedMessages
          .map((q) => `[${q.from} 在你忙时发来]: ${q.content}`)
          .join('\n');
        fullMessage = `${queuedText}\n\n[最新消息]: ${message}`;
      }

      await this.engine!.talk(fullMessage);
    } finally {
      this.isBusy = false;
    }

    // 处理在执行期间新加入的消息
    if (this._messageQueue.length > 0) {
      const next = this._messageQueue.shift()!;
      await this.talk(next.content);
    }
  }

  /**
   * 接收来自其他 Agent 的消息
   */
  receiveMessage(fromAgentId: string, content: string): void {
    this._messageQueue.push({
      from: fromAgentId,
      content,
      ts: Date.now(),
    });

    // 如果不忙，立即处理
    if (!this.isBusy) {
      const msg = this._messageQueue.shift()!;
      this.talk(msg.content).catch((err) => {
        console.error(`[Agent] ${this.name} 处理消息失败:`, err);
      });
    }
  }

  /**
   * 更新 Agent 配置
   */
  updateConfig(newConfig: Partial<AgentData>): void {
    this.config = { ...this.config, ...newConfig };
    if (this.engine instanceof ChatEngine) {
      this.engine.agentData = this.config;
      if (newConfig.systemPrompt) {
        this.engine.systemPrompt = newConfig.systemPrompt;
      }
    }
  }

  /**
   * 设置输出处理器
   */
  setOutputHandler(handler: OutputHandler): void {
    if (this.engine) {
      this.engine.setOutputHandler(handler);
    }
  }

  // ── 私有方法 ──

  private _drainQueue(): Array<{ from: string; content: string; ts: number }> {
    const items = [...this._messageQueue];
    this._messageQueue = [];
    return items;
  }
}
