/**
 * Blessed 终端 UI — midou 的交互界面
 *
 * 布局:
 *   ┌─── 状态栏 ──────────────────────────────────────┐
 *   │ 🐱 midou │ ☀️ 标准 │ 模型名 │ 💓 0 │ ⏰ 0    │
 *   ├─── 对话框 ────────────────────┬── TODO 面板 ────┤
 *   │                                │ □ 任务1         │
 *   │ 用户: ...                      │ ✓ 任务2         │
 *   │ midou: ... (渲染后的 md)       │ □ 任务3         │
 *   │                                │                  │
 *   ├─── 输入框 ──────────────────────────────────────┤
 *   │ > 输入消息...                                    │
 *   └────────────────────────────────────────────────┘
 *
 * 功能:
 *   - 状态栏显示 midou 状态信息 + 定时任务数量 + 最近任务
 *   - 对话框显示渲染后的 md 内容，支持自动滚动和鼠标滚动
 *   - TODO 面板显示 AI 工作计划，实时更新
 *   - 输入框支持常驻输入
 *   - 命令确认支持方向键选择
 */

import blessed from 'blessed';
import chalk from 'chalk';
import { IncrementalMDRenderer, renderMarkdown } from './md-renderer.js';

// ─── TODO 数据管理 ──────────────────────────────────

const _todoItems = [];
let _todoNextId = 1;

export function addTodoItem(title, description = '') {
  const item = { id: _todoNextId++, title, description, status: 'pending' };
  _todoItems.push(item);
  return item;
}

export function updateTodoStatus(id, status) {
  const item = _todoItems.find(t => t.id === id);
  if (item) { item.status = status; return item; }
  return null;
}

export function getTodoItems() {
  return [..._todoItems];
}

export function clearTodoItems() {
  _todoItems.length = 0;
  _todoNextId = 1;
}

export function removeTodoItem(id) {
  const idx = _todoItems.findIndex(t => t.id === id);
  if (idx !== -1) { _todoItems.splice(idx, 1); return true; }
  return false;
}

// ─── Blessed UI 输出处理器 ──────────────────────────

export class BlessedOutputHandler {
  constructor(ui) {
    this.ui = ui;
    this._streamRenderer = null;
  }

  onThinkingStart() {
    this.ui.appendChat('{#C9B1FF-fg}┌─ 💭 思考中…{/#C9B1FF-fg}');
  }

  onThinkingDelta(text) {
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
    // 工具执行后刷新 TODO 面板
    this.ui.refreshTodoPanel();
  }

  onError(message) {
    this.ui.appendChat(`{yellow-fg}⚠  ${blessed.escape(message)}{/yellow-fg}`);
  }

  async confirmCommand(command) {
    return await this.ui.confirmCommand(command);
  }
}

// ─── Blessed 终端 UI ────────────────────────────────

export class BlessedUI {
  constructor() {
    this.screen = null;
    this.statusBar = null;
    this.chatBox = null;
    this.inputBox = null;
    this.todoPanel = null;
    this._autoScroll = true;
    this._onSubmit = null;
    this._onCommand = null;
    this._onQuit = null;
    this._confirmResolve = null;
    this._processing = false;
    this._todoPanelVisible = false;
    this._statusInfo = {
      mode: '☀️  标准',
      model: '',
      heartbeat: 0,
      mcp: 0,
      tasks: 0,
      lastTask: '',
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

    // TODO 面板（初始隐藏，有任务时显示）
    this.todoPanel = blessed.box({
      parent: this.screen,
      top: 1,
      right: 0,
      width: 28,
      height: '100%-4',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      border: { type: 'line' },
      label: ' 📋 工作计划 ',
      style: {
        fg: 'white',
        bg: 'default',
        border: { fg: '#FFD700' },
        label: { fg: '#FFD700' },
      },
      padding: { left: 0, right: 0 },
      hidden: true,
    });

    // 输入框边框
    const inputBorder = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      style: { border: { fg: '#FFB347' } },
    });

    // 输入框
    this.inputBox = blessed.textbox({
      parent: inputBorder,
      top: 0,
      left: 1,
      width: '100%-4',
      height: 1,
      inputOnFocus: true,
      style: { fg: 'white', bg: 'default' },
    });

    this._setupKeyBindings();
    this._updateStatusBar();
    this.screen.render();
    this._focusInput();
  }

  _setupKeyBindings() {
    this.screen.key(['C-c'], () => {
      if (this._onQuit) this._onQuit();
    });

    this.screen.key(['escape'], () => {
      if (this._confirmResolve) {
        this._confirmResolve(false);
        this._confirmResolve = null;
        return;
      }
      if (this._onQuit) this._onQuit();
    });

    this.inputBox.on('submit', (value) => {
      this._handleInput(value).catch(err => {
        this.appendChat(`{red-fg}⚠  错误: ${blessed.escape(err.message)}{/red-fg}`);
        this._processing = false;
        this._focusInput();
      });
    });

    this.inputBox.on('cancel', () => {
      this._focusInput();
    });

    this.chatBox.on('scroll', () => {
      const scrollHeight = this.chatBox.getScrollHeight();
      const scrollTop = this.chatBox.getScroll();
      const boxHeight = this.chatBox.height;
      this._autoScroll = (scrollTop + boxHeight >= scrollHeight - 2);
    });
  }

  async _handleInput(value) {
    const input = (value || '').trim();
    if (!input) { this._focusInput(); return; }
    if (this._processing) { this._focusInput(); return; }
    this._processing = true;

    this.appendChat(`{cyan-fg}你 › {/cyan-fg}${blessed.escape(input)}`);
    this.appendChat('');

    try {
      if (input.startsWith('/')) {
        if (this._onCommand) await this._onCommand(input);
      } else {
        this.appendChat('{#FFB347-fg}🐱 › {/#FFB347-fg}');
        if (this._onSubmit) await this._onSubmit(input);
      }
    } finally {
      this._processing = false;
    }
    this._focusInput();
  }

  _focusInput() {
    this.inputBox.clearValue();
    this.inputBox.focus();
    this.screen.render();
  }

  appendChat(text) {
    const current = this.chatBox.getContent();
    const newContent = current ? current + '\n' + text : text;
    this.chatBox.setContent(newContent);
    if (this._autoScroll) {
      this.chatBox.setScrollPerc(100);
    }
    this.screen.render();
  }

  updateStatus(info) {
    Object.assign(this._statusInfo, info);
    this._updateStatusBar();
    this.screen.render();
  }

  _updateStatusBar() {
    if (!this.statusBar) return;
    const s = this._statusInfo;
    const parts = [
      ' 🐱 midou',
      `  ${s.mode}  `,
      s.model,
      `💓 ${s.heartbeat}`,
    ];
    if (s.tasks > 0) {
      parts.push(`⏰ ${s.tasks}`);
    }
    if (s.mcp > 0) {
      parts.push(`🔌 ${s.mcp}`);
    }
    if (s.lastTask) {
      parts.push(s.lastTask.length > 20 ? s.lastTask.slice(0, 20) + '…' : s.lastTask);
    }
    parts.push(s.status);
    this.statusBar.setContent(parts.join(' │ '));
  }

  /**
   * 显示命令确认对话框（支持方向键选择）
   */
  async confirmCommand(command) {
    return new Promise((resolve) => {
      this._confirmResolve = resolve;
      let selected = 0; // 0=确认, 1=拒绝

      const renderButtons = () => {
        const yesBtn = selected === 0
          ? '{green-bg}{bold} ✓ 确认执行 {/bold}{/green-bg}'
          : '{white-fg} ✓ 确认执行 {/white-fg}';
        const noBtn = selected === 1
          ? '{red-bg}{bold} ✗ 拒绝 {/bold}{/red-bg}'
          : '{white-fg} ✗ 拒绝 {/white-fg}';
        return `${yesBtn}    ${noBtn}`;
      };

      const updateContent = () => {
        dialog.setContent(
          '{yellow-fg}{bold}⚠ 命令确认{/bold}{/yellow-fg}\n\n' +
          '{white-fg}即将执行以下命令:{/white-fg}\n\n' +
          `{cyan-fg}$ ${blessed.escape(command)}{/cyan-fg}\n\n` +
          renderButtons() + '\n\n' +
          '{white-fg}← → 选择  Enter 确认  Esc 取消{/white-fg}'
        );
        this.screen.render();
      };

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
      });

      dialog.focus();
      updateContent();

      const cleanup = (result) => {
        dialog.destroy();
        this._confirmResolve = null;
        this.screen.render();
        resolve(result);
      };

      dialog.key(['left', 'right'], (ch, key) => {
        selected = selected === 0 ? 1 : 0;
        updateContent();
      });

      dialog.key(['enter', 'return'], () => {
        cleanup(selected === 0);
      });

      dialog.key(['y'], () => cleanup(true));
      dialog.key(['n', 'escape'], () => cleanup(false));
    });
  }

  /**
   * 显示/隐藏 TODO 面板
   */
  showTodoPanel() {
    if (this._todoPanelVisible) return;
    this._todoPanelVisible = true;
    this.todoPanel.show();
    // 缩小对话框宽度给 TODO 面板留空间
    this.chatBox.width = '100%-28';
    this.refreshTodoPanel();
    this.screen.render();
  }

  hideTodoPanel() {
    if (!this._todoPanelVisible) return;
    this._todoPanelVisible = false;
    this.todoPanel.hide();
    this.chatBox.width = '100%';
    this.screen.render();
  }

  /**
   * 刷新 TODO 面板内容
   */
  refreshTodoPanel() {
    const items = getTodoItems();

    // 有任务时自动显示面板
    if (items.length > 0 && !this._todoPanelVisible) {
      this.showTodoPanel();
    }

    if (!this._todoPanelVisible) return;

    const lines = [];
    for (const item of items) {
      let icon, color;
      switch (item.status) {
        case 'done':
          icon = '✓'; color = '{green-fg}'; break;
        case 'in_progress':
          icon = '►'; color = '{yellow-fg}'; break;
        case 'blocked':
          icon = '✗'; color = '{red-fg}'; break;
        default:
          icon = '□'; color = '{white-fg}'; break;
      }
      const endColor = color.replace('{', '{/');
      const title = item.title.length > 22
        ? item.title.slice(0, 22) + '…'
        : item.title;
      lines.push(`${color}${icon} ${blessed.escape(title)}${endColor}`);
    }

    // 统计
    const done = items.filter(i => i.status === 'done').length;
    const total = items.length;
    if (total > 0) {
      lines.push('');
      lines.push(`{white-fg}${done}/${total} 完成{/white-fg}`);
    }

    this.todoPanel.setContent(lines.join('\n'));
    this.screen.render();
  }

  showSystemMessage(text) {
    this.appendChat(`{yellow-fg}${blessed.escape(text)}{/yellow-fg}`);
  }

  showReminder(reminder) {
    const type = reminder.repeat ? `每 ${reminder.intervalMinutes} 分钟` : '一次性';
    this.appendChat('');
    this.appendChat(`{#FFD700-fg}⏰ ${blessed.escape(reminder.text)}{/#FFD700-fg}`);
    if (reminder.repeat) {
      this.appendChat(`{white-fg}   ${type} · 第 ${reminder.firedCount} 次{/white-fg}`);
    }
    this.appendChat('');
  }

  showHeartbeat(msg) {
    this.appendChat('');
    this.appendChat(`{#FF6B9D-fg}💓 ${blessed.escape(msg.slice(0, 100))}{/#FF6B9D-fg}`);
    this.appendChat('');
  }

  onSubmit(fn) { this._onSubmit = fn; }
  onCommand(fn) { this._onCommand = fn; }
  onQuit(fn) { this._onQuit = fn; }

  destroy() {
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
  }
}
