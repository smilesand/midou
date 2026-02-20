/**
 * Blessed 终端 UI — midou 的交互界面
 *
 * 布局:
 *   ┌─── 状态栏 ──────────────────────────────┐
 *   │ 🐱 midou │ ☀️ 标准 │ 模型名 │ 💓 0    │
 *   ├─── 对话框 ──────────────────────────────┤
 *   │                                          │
 *   │ 用户: ...                                │
 *   │ midou: ... (渲染后的 markdown)           │
 *   │                                          │
 *   ├─── 输入框 ──────────────────────────────┤
 *   │ > 输入消息...                            │
 *   └────────────────────────────────────────┘
 *
 * 功能:
 *   - 状态栏显示 midou 状态信息
 *   - 对话框显示渲染后的 md 内容，支持自动滚动和鼠标滚动
 *   - 输入框支持常驻输入
 *   - 命令确认对话框
 *   - 系统通知
 */

import blessed from 'blessed';
import chalk from 'chalk';
import { IncrementalMDRenderer, renderMarkdown } from './md-renderer.js';

/**
 * Blessed UI 输出处理器 — 接入 ChatEngine
 */
export class BlessedOutputHandler {
  constructor(ui) {
    this.ui = ui;
    this._streamRenderer = null;
  }

  onThinkingStart() {
    this.ui.appendChat('{#C9B1FF-fg}┌─ 💭 思考中…{/#C9B1FF-fg}');
  }

  onThinkingDelta(text) {
    // 思考内容不渲染 markdown，直接追加
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.ui.appendChat(`{#C9B1FF-fg}│ ${blessed.escape(line)}{/#C9B1FF-fg}`);
      }
    }
  }

  onThinkingEnd(fullText) {
    if (fullText) {
      this.ui.appendChat(`{#C9B1FF-fg}└─ ${fullText.length} 字{/#C9B1FF-fg}`);
      this.ui.appendChat('');
    }
  }

  onThinkingHidden(length) {
    this.ui.appendChat(`{#C9B1FF-fg}💭 ${length} 字 — /think 查看{/#C9B1FF-fg}`);
  }

  onTextDelta(text) {
    // 流式增量 md 渲染
    if (!this._streamRenderer) {
      this._streamRenderer = new IncrementalMDRenderer((rendered) => {
        this.ui.appendChat(blessed.escape(rendered));
      });
    }
    this._streamRenderer.feed(text);
  }

  onTextComplete() {
    if (this._streamRenderer) {
      this._streamRenderer.flush();
      this._streamRenderer = null;
    }
    this.ui.appendChat('');
  }

  onToolStart(name) {
    const isMCP = name.startsWith('mcp_');
    const icon = isMCP ? '🔌' : '⚙';
    this.ui.appendChat(`{#7FDBFF-fg}${icon}  ${blessed.escape(name)}{/#7FDBFF-fg}`);
  }

  onToolEnd(name, input) {
    const short = JSON.stringify(input).slice(0, 60);
    this.ui.appendChat(`{#7FDBFF-fg}   ${blessed.escape(short)}{/#7FDBFF-fg}`);
  }

  onToolExec(name) {
    this.ui.appendChat(`{#7FDBFF-fg}  ↳ ${blessed.escape(name)}…{/#7FDBFF-fg}`);
  }

  onToolResult() {
    this.ui.appendChat('{green-fg}  ✓{/green-fg}');
  }

  onError(message) {
    this.ui.appendChat(`{yellow-fg}⚠  ${blessed.escape(message)}{/yellow-fg}`);
  }

  async confirmCommand(command) {
    return await this.ui.confirmCommand(command);
  }
}

/**
 * Blessed 终端 UI
 */
export class BlessedUI {
  constructor() {
    this.screen = null;
    this.statusBar = null;
    this.chatBox = null;
    this.inputBox = null;
    this.isInputFocused = true;
    this._autoScroll = true;
    this._onSubmit = null;     // 用户输入回调
    this._onCommand = null;    // 命令回调
    this._onQuit = null;       // 退出回调
    this._confirmResolve = null;
    this._processing = false;  // 是否正在处理输入
    this._statusInfo = {
      mode: '☀️ 标准',
      model: '',
      heartbeat: 0,
      mcp: 0,
      status: '就绪',
    };
  }

  /**
   * 初始化 UI
   */
  init() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'midou — 你的 AI 伙伴',
      fullUnicode: true,
      mouse: true,
    });

    // 状态栏
    this.statusBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        fg: 'white',
        bg: '#333333',
      },
    });

    // 对话框
    this.chatBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-4',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        style: { bg: '#FFB347' },
      },
      mouse: true,
      keys: true,
      vi: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
      padding: { left: 1, right: 1 },
    });

    // 输入框边框
    const inputBorder = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: {
        type: 'line',
      },
      style: {
        border: { fg: '#FFB347' },
      },
    });

    // 输入框
    this.inputBox = blessed.textbox({
      parent: inputBorder,
      top: 0,
      left: 1,
      width: '100%-4',
      height: 1,
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    this._setupKeyBindings();
    this._updateStatusBar();
    this.screen.render();
    this._focusInput();
  }

  /**
   * 设置按键绑定
   */
  _setupKeyBindings() {
    // Ctrl+C / Escape 退出
    this.screen.key(['C-c'], () => {
      if (this._onQuit) this._onQuit();
    });

    this.screen.key(['escape'], () => {
      // 如果有确认对话框正在显示，取消它
      if (this._confirmResolve) {
        this._confirmResolve(false);
        this._confirmResolve = null;
        return;
      }
      if (this._onQuit) this._onQuit();
    });

    // 输入框提交
    this.inputBox.on('submit', (value) => {
      this._handleInput(value).catch(err => {
        this.appendChat(`{red-fg}⚠  错误: ${blessed.escape(err.message)}{/red-fg}`);
        this._processing = false;
        this._focusInput();
      });
    });

    // 输入框取消（Escape）
    this.inputBox.on('cancel', () => {
      this._focusInput();
    });

    // 鼠标滚动时禁用自动滚动
    this.chatBox.on('scroll', () => {
      const scrollHeight = this.chatBox.getScrollHeight();
      const scrollTop = this.chatBox.getScroll();
      const boxHeight = this.chatBox.height;
      // 如果用户手动滚动到非底部位置，禁用自动滚动
      this._autoScroll = (scrollTop + boxHeight >= scrollHeight - 2);
    });
  }

  /**
   * 处理用户输入
   */
  async _handleInput(value) {
    const input = (value || '').trim();
    if (!input) {
      this._focusInput();
      return;
    }

    // 防止处理过程中的重复提交
    if (this._processing) {
      this._focusInput();
      return;
    }
    this._processing = true;

    // 显示用户消息
    this.appendChat(`{cyan-fg}你 › {/cyan-fg}${blessed.escape(input)}`);
    this.appendChat('');

    try {
      if (input.startsWith('/')) {
        // 命令
        if (this._onCommand) {
          await this._onCommand(input);
        }
      } else {
        // 对话
        this.appendChat('{#FFB347-fg}🐱 › {/#FFB347-fg}');
        if (this._onSubmit) {
          await this._onSubmit(input);
        }
      }
    } finally {
      this._processing = false;
    }

    this._focusInput();
  }

  /**
   * 聚焦输入框
   */
  _focusInput() {
    this.inputBox.clearValue();
    this.inputBox.focus();
    this.screen.render();
  }

  /**
   * 追加内容到对话框
   */
  appendChat(text) {
    const current = this.chatBox.getContent();
    const newContent = current ? current + '\n' + text : text;
    this.chatBox.setContent(newContent);

    // 自动滚动到底部
    if (this._autoScroll) {
      this.chatBox.setScrollPerc(100);
    }
    this.screen.render();
  }

  /**
   * 更新状态栏信息
   */
  updateStatus(info) {
    Object.assign(this._statusInfo, info);
    this._updateStatusBar();
    this.screen.render();
  }

  /**
   * 渲染状态栏
   */
  _updateStatusBar() {
    if (!this.statusBar) return;
    const s = this._statusInfo;
    const parts = [
      ` 🐱 midou`,
      s.mode,
      s.model,
      `💓 ${s.heartbeat}`,
      s.mcp > 0 ? `🔌 ${s.mcp}` : '',
      s.status,
    ].filter(Boolean);
    this.statusBar.setContent(` ${parts.join(' │ ')} `);
  }

  /**
   * 显示命令确认对话框
   * @returns {Promise<boolean>}
   */
  async confirmCommand(command) {
    return new Promise((resolve) => {
      this._confirmResolve = resolve;

      const dialog = blessed.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: '80%',
        height: 'shrink',
        border: { type: 'line' },
        style: {
          border: { fg: 'yellow' },
          bg: '#1a1a1a',
        },
        padding: 1,
        tags: true,
        content:
          '{yellow-fg}{bold}⚠ 命令确认{/bold}{/yellow-fg}\n\n' +
          `{white-fg}即将执行以下命令:{/white-fg}\n\n` +
          `{cyan-fg}$ ${blessed.escape(command)}{/cyan-fg}\n\n` +
          '{green-fg}[Y]{/green-fg} 确认执行  {red-fg}[N]{/red-fg} 拒绝',
      });

      dialog.focus();

      const cleanup = (result) => {
        dialog.destroy();
        this._confirmResolve = null;
        this.screen.render();
        resolve(result);
      };

      dialog.key(['y'], () => cleanup(true));
      dialog.key(['n', 'escape'], () => cleanup(false));

      this.screen.render();
    });
  }

  /**
   * 显示系统信息
   */
  showSystemMessage(text) {
    this.appendChat(`{yellow-fg}${blessed.escape(text)}{/yellow-fg}`);
  }

  /**
   * 显示提醒通知
   */
  showReminder(reminder) {
    const type = reminder.repeat ? `每 ${reminder.intervalMinutes} 分钟` : '一次性';
    this.appendChat('');
    this.appendChat(`{#FFD700-fg}⏰ ${blessed.escape(reminder.text)}{/#FFD700-fg}`);
    if (reminder.repeat) {
      this.appendChat(`{white-fg}   ${type} · 第 ${reminder.firedCount} 次{/white-fg}`);
    }
    this.appendChat('');
  }

  /**
   * 显示心跳消息
   */
  showHeartbeat(msg) {
    this.appendChat('');
    this.appendChat(`{#FF6B9D-fg}💓 ${blessed.escape(msg.slice(0, 100))}{/#FF6B9D-fg}`);
    this.appendChat('');
  }

  /**
   * 设置回调函数
   */
  onSubmit(fn) { this._onSubmit = fn; }
  onCommand(fn) { this._onCommand = fn; }
  onQuit(fn) { this._onQuit = fn; }

  /**
   * 销毁 UI
   */
  destroy() {
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
  }
}
