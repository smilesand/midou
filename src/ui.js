/**
 * Blessed 终端 UI — midou 的交互界面
 *
 * 布局:
 *   ┌─── 状态栏 ──────────────────────────────────────┐
 *   │ 🐱 midou │ ☀️ 标准 │ 模型名 │ 💓 0 │ ⏰ 0    │
 *   ├─── 对话框 ────────────────────┬── TODO 面板 ────┤
 *   │ ┌ 你 ──────────────────┐      │ □ 任务1         │
 *   │ │ 用户消息             │      │ ✓ 任务2         │
 *   │ └─────────────────────┘      │ □ 任务3         │
 *   │ ┌ 🐱 ─────────────────┐      │                  │
 *   │ │ AI 回复 (渲染 md)    │      │                  │
 *   │ └─────────────────────┘      │                  │
 *   ├─── 输入框 ──────────────────────────────────────┤
 *   │ > 输入消息...                                    │
 *   └────────────────────────────────────────────────┘
 *
 * 功能:
 *   - 聊天气泡区分用户/AI/思考/工具消息
 *   - 输入框支持左右方向键编辑
 *   - TODO 面板全部完成后自动关闭
 */

import blessed from 'blessed';
import chalk from 'chalk';
import { IncrementalMDRenderer, renderMarkdown } from './md-renderer.js';

// blessed 内置的 Unicode 宽度计算（CJK 双宽字符支持）
const unicode = blessed.unicode;

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

// ─── 气泡样式工具 ────────────────────────────────────

/**
 * 为消息添加气泡边框
 * @param {string} content - 消息内容（可包含 blessed tags）
 * @param {'user'|'ai'|'thinking'|'tool'|'system'} role - 角色
 * @returns {string[]} 气泡行数组
 */
function makeBubble(content, role) {
  const styles = {
    user:     { color: '{cyan-fg}',    endColor: '{/cyan-fg}',    label: ' 你 ' },
    ai:       { color: '{#FFB347-fg}', endColor: '{/#FFB347-fg}', label: ' 🐱 ' },
    thinking: { color: '{#C9B1FF-fg}', endColor: '{/#C9B1FF-fg}', label: ' 💭 ' },
    tool:     { color: '{#7FDBFF-fg}', endColor: '{/#7FDBFF-fg}', label: ' ⚙ ' },
    system:   { color: '{yellow-fg}',  endColor: '{/yellow-fg}',  label: ' ℹ ' },
  };
  const s = styles[role] || styles.system;
  const lines = content.split('\n');
  const result = [];

  result.push(`${s.color}┌─${s.label}${'─'.repeat(Math.max(0, 40 - s.label.length))}${s.endColor}`);
  for (const line of lines) {
    result.push(`${s.color}│${s.endColor} ${line}`);
  }
  result.push(`${s.color}└${'─'.repeat(42)}${s.endColor}`);
  return result;
}

// ─── Blessed UI 输出处理器 ──────────────────────────

export class BlessedOutputHandler {
  constructor(ui) {
    this.ui = ui;
    this._streamRenderer = null;
    this._thinkingLines = [];
    this._aiLines = [];
  }

  onThinkingStart() {
    this._thinkingLines = [];
    this._thinkingLines.push('思考中…');
  }

  onThinkingDelta(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this._thinkingLines.push(line);
      }
    }
  }

  onThinkingEnd(fullText) {
    if (fullText) {
      this._thinkingLines.push(`── ${fullText.length} 字`);
      const bubble = makeBubble(
        this._thinkingLines.map(l => blessed.escape(l)).join('\n'),
        'thinking'
      );
      for (const line of bubble) this.ui.appendChat(line);
      this.ui.appendChat('');
    }
    this._thinkingLines = [];
  }

  onThinkingHidden(length) {
    const bubble = makeBubble(`${length} 字 — /think 查看`, 'thinking');
    for (const line of bubble) this.ui.appendChat(line);
  }

  onTextDelta(text) {
    if (!this._streamRenderer) {
      this._aiLines = [];
      this._streamRenderer = new IncrementalMDRenderer((rendered) => {
        // 收集渲染后的行
        this._aiLines.push(blessed.escape(rendered));
        // 实时输出：直接追加（后续 onTextComplete 不再重复）
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
    this.ui.appendChat(`{#7FDBFF-fg}┌─ ${icon} ${blessed.escape(name)}{/#7FDBFF-fg}`);
  }

  onToolEnd(name, input) {
    const short = JSON.stringify(input).slice(0, 60);
    this.ui.appendChat(`{#7FDBFF-fg}│ ${blessed.escape(short)}{/#7FDBFF-fg}`);
  }

  onToolExec(name) {
    this.ui.appendChat(`{#7FDBFF-fg}│ ↳ ${blessed.escape(name)}…{/#7FDBFF-fg}`);
  }

  onToolResult() {
    this.ui.appendChat('{#7FDBFF-fg}└─ {green-fg}✓{/green-fg}{/#7FDBFF-fg}');
    this.ui.appendChat('');
    this.ui.refreshTodoPanel();
  }

  onError(message) {
    const bubble = makeBubble(blessed.escape(message), 'system');
    for (const line of bubble) this.ui.appendChat(line);
  }

  async confirmCommand(command) {
    return await this.ui.confirmCommand(command);
  }
}

// ─── Blessed 终端 UI ────────────────────────────────
//
// 输入机制：不使用 blessed textbox 的 readInput/submit 状态机，
// 而是直接监听 program 级 keypress 事件，完全自主管理输入状态。
// 这样做避免了 blessed textbox 的以下问题：
//   - readInput 内部使用 setImmediate 延迟添加 listener
//   - _done 执行后删除自身（delete self._done）
//   - focus() 在已聚焦时是空操作导致 readInput 不被触发
//   - _updateCursor 中 _getWidth 递归溢出

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
    this._processing = false;
    this._todoPanelVisible = false;

    // 输入状态
    this._inputValue = '';
    this._inputCursor = 0;

    // 确认弹窗状态（null = 无弹窗）
    this._confirmState = null;

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
      style: { fg: 'white', bg: '#333333' },
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
      scrollbar: { style: { bg: '#FFB347' } },
      mouse: true,
      keys: true,
      vi: true,
      style: { fg: 'white', bg: 'default' },
      padding: { left: 1, right: 1 },
    });

    // TODO 面板（初始隐藏）
    this.todoPanel = blessed.box({
      parent: this.screen,
      top: 1,
      right: 0,
      width: 30,
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
      padding: { left: 1, right: 1 },
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

    // 输入框（普通 box，不使用 textbox，避免 readInput 状态机问题）
    this.inputBox = blessed.box({
      parent: inputBorder,
      top: 0,
      left: 1,
      width: '100%-4',
      height: 1,
      style: { fg: 'white', bg: 'default' },
    });

    // 让 inputBox 可被 focus 以便 screen.render 时定位光标
    this.inputBox.focus();
    this.inputBox._updateCursor = () => this._positionCursor();

    this._setupInput();
    this._updateStatusBar();
    this.screen.program.showCursor();
    this.screen.render();
  }

  // ─── 输入处理 ──────────────────────────────────────

  /**
   * 注册唯一的 program 级 keypress 处理器，
   * 根据当前状态路由到输入框或确认弹窗。
   */
  _setupInput() {
    this.screen.program.on('keypress', (ch, key) => {
      if (!key) return;
      // Ctrl-C 全局退出
      if (key.ctrl && key.name === 'c') {
        if (this._onQuit) this._onQuit();
        return;
      }
      if (this._confirmState) {
        this._handleConfirmKey(ch, key);
      } else {
        this._handleInputKey(ch, key);
      }
    });

    this.chatBox.on('scroll', () => {
      const scrollHeight = this.chatBox.getScrollHeight();
      const scrollTop = this.chatBox.getScroll();
      const boxHeight = this.chatBox.height;
      this._autoScroll = (scrollTop + boxHeight >= scrollHeight - 2);
    });
  }

  _handleInputKey(ch, key) {
    if (key.name === 'escape') {
      if (this._onQuit) this._onQuit();
      return;
    }

    if (key.name === 'enter' || key.name === 'return' || key.name === 'linefeed') {
      const value = this._inputValue.trim();
      this._inputValue = '';
      this._inputCursor = 0;
      this._renderInput();
      if (!value || this._processing) return;
      this._processing = true;
      this._doHandleInput(value).catch(err => {
        this.appendChat(`{red-fg}⚠  错误: ${blessed.escape(err.message)}{/red-fg}`);
      }).finally(() => {
        this._processing = false;
      });
      return;
    }

    if (key.name === 'left') {
      if (this._inputCursor > 0) { this._inputCursor--; this._renderInput(); }
      return;
    }
    if (key.name === 'right') {
      if (this._inputCursor < this._inputValue.length) { this._inputCursor++; this._renderInput(); }
      return;
    }
    if (key.name === 'home') {
      this._inputCursor = 0; this._renderInput(); return;
    }
    if (key.name === 'end') {
      this._inputCursor = this._inputValue.length; this._renderInput(); return;
    }

    if (key.name === 'backspace') {
      if (this._inputCursor > 0) {
        this._inputValue = this._inputValue.slice(0, this._inputCursor - 1) + this._inputValue.slice(this._inputCursor);
        this._inputCursor--;
        this._renderInput();
      }
      return;
    }
    if (key.name === 'delete') {
      if (this._inputCursor < this._inputValue.length) {
        this._inputValue = this._inputValue.slice(0, this._inputCursor) + this._inputValue.slice(this._inputCursor + 1);
        this._renderInput();
      }
      return;
    }

    // 普通字符输入（过滤所有控制字符 0x00-0x1f 和 DEL 0x7f）
    if (ch && !key.ctrl && !key.meta && !/^[\x00-\x1f\x7f]$/.test(ch)) {
      this._inputValue = this._inputValue.slice(0, this._inputCursor) + ch + this._inputValue.slice(this._inputCursor);
      this._inputCursor++;
      this._renderInput();
    }
  }

  _renderInput() {
    this.inputBox.setContent(this._inputValue);
    this.screen.render();
  }

  _positionCursor() {
    try {
      const lpos = this.inputBox.lpos;
      if (!lpos) return;
      // 使用 unicode.strWidth 计算光标前文本的显示宽度（CJK 字符占两列）
      const textBeforeCursor = this._inputValue.slice(0, this._inputCursor);
      const displayWidth = unicode.strWidth(textBeforeCursor);
      const cx = lpos.xi + this.inputBox.ileft + displayWidth;
      const cy = lpos.yi + this.inputBox.itop;
      this.screen.program.cup(cy, cx);
      if (this.screen.program.cursorHidden) {
        this.screen.program.showCursor();
      }
    } catch (_) { /* 忽略布局过渡异常 */ }
  }

  // ─── 用户输入分发 ──────────────────────────────────

  async _doHandleInput(input) {
    const userBubble = makeBubble(blessed.escape(input), 'user');
    for (const line of userBubble) this.appendChat(line);
    this.appendChat('');

    if (input.startsWith('/')) {
      if (this._onCommand) await this._onCommand(input);
    } else {
      if (this._onSubmit) await this._onSubmit(input);
    }
  }

  // ─── 对话框 ────────────────────────────────────────

  appendChat(text) {
    const current = this.chatBox.getContent();
    const newContent = current ? current + '\n' + text : text;
    this.chatBox.setContent(newContent);
    if (this._autoScroll) {
      this.chatBox.setScrollPerc(100);
    }
    this.screen.render();
  }

  // ─── 状态栏 ────────────────────────────────────────

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

  // ─── 命令确认弹窗 ──────────────────────────────────

  async confirmCommand(command) {
    return new Promise((resolve) => {
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

      this._confirmState = { selected: 0, command, dialog, resolve };
      this._renderConfirmDialog();
    });
  }

  _handleConfirmKey(_ch, key) {
    if (key.name === 'left' || key.name === 'right') {
      this._confirmState.selected = this._confirmState.selected === 0 ? 1 : 0;
      this._renderConfirmDialog();
      return;
    }
    if (key.name === 'enter') {
      this._resolveConfirm(this._confirmState.selected === 0);
      return;
    }
    if (key.name === 'y') { this._resolveConfirm(true); return; }
    if (key.name === 'n' || key.name === 'escape') { this._resolveConfirm(false); return; }
  }

  _renderConfirmDialog() {
    const s = this._confirmState;
    const yesBtn = s.selected === 0
      ? '{green-bg}{bold} ✓ 确认执行 {/bold}{/green-bg}'
      : '{white-fg} ✓ 确认执行 {/white-fg}';
    const noBtn = s.selected === 1
      ? '{red-bg}{bold} ✗ 拒绝 {/bold}{/red-bg}'
      : '{white-fg} ✗ 拒绝 {/white-fg}';
    s.dialog.setContent(
      '{yellow-fg}{bold}⚠ 命令确认{/bold}{/yellow-fg}\n\n' +
      '{white-fg}即将执行以下命令:{/white-fg}\n\n' +
      `{cyan-fg}$ ${blessed.escape(s.command)}{/cyan-fg}\n\n` +
      `${yesBtn}    ${noBtn}\n\n` +
      '{white-fg}← → 选择  Enter 确认  Y/N 快捷键  Esc 取消{/white-fg}'
    );
    this.screen.render();
  }

  _resolveConfirm(result) {
    const s = this._confirmState;
    if (!s) return;
    s.dialog.destroy();
    this._confirmState = null;
    this.screen.render();
    s.resolve(result);
  }

  // ─── TODO 面板 ─────────────────────────────────────

  showTodoPanel() {
    if (this._todoPanelVisible) return;
    this._todoPanelVisible = true;
    this.todoPanel.show();
    this.chatBox.width = '100%-30';
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

  refreshTodoPanel() {
    const items = getTodoItems();

    if (items.length === 0) {
      if (this._todoPanelVisible) this.hideTodoPanel();
      return;
    }

    const allDone = items.every(i => i.status === 'done');
    if (allDone) {
      setTimeout(() => this.hideTodoPanel(), 2000);
    }

    if (!this._todoPanelVisible) {
      this.showTodoPanel();
      return;
    }

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

    const done = items.filter(i => i.status === 'done').length;
    const total = items.length;
    lines.push('');
    lines.push(`{white-fg}${done}/${total} 完成{/white-fg}`);

    this.todoPanel.setContent(lines.join('\n'));
    this.screen.render();
  }

  // ─── 消息显示 ──────────────────────────────────────

  showSystemMessage(text) {
    const bubble = makeBubble(blessed.escape(text), 'system');
    for (const line of bubble) this.appendChat(line);
  }

  showReminder(reminder) {
    const type = reminder.repeat ? `每 ${reminder.intervalMinutes} 分钟` : '一次性';
    const content = `⏰ ${reminder.text}` +
      (reminder.repeat ? `\n${type} · 第 ${reminder.firedCount} 次` : '');
    const bubble = makeBubble(blessed.escape(content), 'system');
    this.appendChat('');
    for (const line of bubble) this.appendChat(line);
    this.appendChat('');
  }

  showHeartbeat(msg) {
    this.appendChat('');
    this.appendChat(`{#FF6B9D-fg}💓 ${blessed.escape(msg.slice(0, 100))}{/#FF6B9D-fg}`);
    this.appendChat('');
  }

  // ─── 生命周期 ──────────────────────────────────────

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
