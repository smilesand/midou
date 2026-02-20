/**
 * 增量 Markdown 渲染器 — 流式输出的 Markdown 实时渲染
 *
 * 核心算法：
 *   1. 缓冲区累积流式文本块
 *   2. 检测"完整的 markdown 块"（段落、标题、代码块、列表等）
 *   3. 完整块立即通过 marked-terminal 渲染输出
 *   4. 未完成的块保留在缓冲区等待更多内容
 *   5. 超时保护：长时间未闭合的块强制渲染
 *   6. 流结束时 flush 剩余内容
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';

// 配置 marked 使用终端渲染器
marked.use(
  markedTerminal({
    width: 80,
    reflowText: true,
    tab: 2,
    emoji: true,
  })
);

/**
 * 渲染 markdown 文本为终端格式
 */
export function renderMarkdown(text) {
  if (!text || !text.trim()) return '';
  try {
    return marked.parse(text).replace(/\n+$/, '');
  } catch {
    return text;
  }
}

/**
 * 增量 Markdown 渲染器
 *
 * 用法:
 *   const renderer = new IncrementalMDRenderer(onRendered);
 *   renderer.feed(chunk);  // 流式喂入文本
 *   renderer.flush();      // 流结束时调用
 */
export class IncrementalMDRenderer {
  /**
   * @param {function} onRendered - 当一个完整块渲染完成时的回调 (renderedText: string) => void
   * @param {object} options
   * @param {number} options.flushTimeout - 超时强制渲染时间（毫秒），默认 3000
   */
  constructor(onRendered, options = {}) {
    this.onRendered = onRendered;
    this.buffer = '';
    this.inFencedCode = false;  // 是否在 ``` 代码块内
    this.codeFence = '';        // 代码块围栏标记（``` 或 ~~~）
    this.flushTimeout = options.flushTimeout || 3000;
    this._timer = null;
    this._renderedBlocks = [];  // 已渲染块的记录
  }

  /**
   * 喂入一个文本块
   */
  feed(chunk) {
    this.buffer += chunk;
    this._resetTimer();
    this._tryExtractBlocks();
  }

  /**
   * 流结束，强制渲染所有剩余内容
   */
  flush() {
    this._clearTimer();
    if (this.buffer.trim()) {
      const rendered = renderMarkdown(this.buffer);
      if (rendered) {
        this.onRendered(rendered);
        this._renderedBlocks.push(rendered);
      }
      this.buffer = '';
    }
    this.inFencedCode = false;
    this.codeFence = '';
  }

  /**
   * 重置渲染器状态
   */
  reset() {
    this._clearTimer();
    this.buffer = '';
    this.inFencedCode = false;
    this.codeFence = '';
    this._renderedBlocks = [];
  }

  /**
   * 获取所有已渲染的块
   */
  getRenderedBlocks() {
    return this._renderedBlocks;
  }

  /**
   * 尝试从缓冲区提取并渲染完整的 markdown 块
   *
   * 块类型与完成判断：
   *   - 标题 (# ...) → 行末完成
   *   - 代码块 (```) → 闭合 ``` 完成
   *   - 段落 → 空行分隔完成
   *   - 列表 → 空行分隔完成
   *   - 引用 → 空行分隔完成
   *   - 分割线 → 行末完成
   */
  _tryExtractBlocks() {
    // 代码块内部：只寻找闭合标记
    if (this.inFencedCode) {
      this._tryCloseCodeBlock();
      return;
    }

    // 非代码块：按空行分割尝试提取
    this._tryExtractByBlankLines();
  }

  /**
   * 在代码块内寻找闭合标记
   */
  _tryCloseCodeBlock() {
    const fence = this.codeFence;
    const lines = this.buffer.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // 闭合标记：行首是代码围栏且至少与开启围栏等长
      if (trimmed.startsWith(fence) && trimmed === fence) {
        // 找到闭合 → 渲染整个代码块
        const blockLines = lines.slice(0, i + 1);
        const remainder = lines.slice(i + 1);
        const blockText = blockLines.join('\n');

        const rendered = renderMarkdown(blockText);
        if (rendered) {
          this.onRendered(rendered);
          this._renderedBlocks.push(rendered);
        }

        this.buffer = remainder.join('\n');
        this.inFencedCode = false;
        this.codeFence = '';

        // 继续尝试提取后续块
        if (this.buffer.trim()) {
          this._tryExtractBlocks();
        }
        return;
      }
    }
    // 未找到闭合标记，等待更多内容
  }

  /**
   * 按空行分割提取完整块
   */
  _tryExtractByBlankLines() {
    // 寻找双换行符分隔的块
    const parts = this.buffer.split(/\n\n/);

    if (parts.length <= 1) {
      // 没有空行分隔，检查是否有单行完成的块（如标题）
      this._tryExtractSingleLineBlocks();
      return;
    }

    // 检查最后一部分是否完整
    // 除了最后一个 part，其他都是已完成的块
    const completeParts = parts.slice(0, -1);
    const lastPart = parts[parts.length - 1];

    // 检查完整部分中是否包含未闭合的代码块
    const combined = completeParts.join('\n\n');
    const fenceInfo = this._detectCodeFence(combined);

    if (fenceInfo.unclosed) {
      // 存在未闭合代码块，不能渲染
      this.inFencedCode = true;
      this.codeFence = fenceInfo.fence;
      return;
    }

    // 渲染完整的部分
    if (combined.trim()) {
      const rendered = renderMarkdown(combined);
      if (rendered) {
        this.onRendered(rendered);
        this._renderedBlocks.push(rendered);
      }
    }

    // 保留最后未完成的部分
    this.buffer = lastPart;

    // 检查剩余部分是否开始了代码块
    const remainInfo = this._detectCodeFence(this.buffer);
    if (remainInfo.unclosed) {
      this.inFencedCode = true;
      this.codeFence = remainInfo.fence;
    }
  }

  /**
   * 尝试提取单行完成的块（标题、分割线等）
   */
  _tryExtractSingleLineBlocks() {
    // 只有在缓冲区以换行结尾且包含完整行时才处理
    if (!this.buffer.includes('\n')) return;

    const lines = this.buffer.split('\n');
    // 如果最后一行不是空的（还在输入中），不处理
    if (lines[lines.length - 1] !== '') return;

    // 检查是否进入了代码块
    const fenceMatch = lines[0].match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      this.inFencedCode = true;
      this.codeFence = fenceMatch[1];
      return;
    }
  }

  /**
   * 检测文本中的代码围栏状态
   * @returns {{ unclosed: boolean, fence: string }}
   */
  _detectCodeFence(text) {
    const lines = text.split('\n');
    let inCode = false;
    let fence = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!inCode) {
        const match = trimmed.match(/^(`{3,}|~{3,})/);
        if (match) {
          inCode = true;
          fence = match[1].charAt(0).repeat(match[1].length);
        }
      } else {
        // 检查是否是闭合标记
        if (trimmed === fence || (trimmed.startsWith(fence) && trimmed.replace(/[`~]/g, '') === '')) {
          inCode = false;
          fence = '';
        }
      }
    }

    return { unclosed: inCode, fence };
  }

  /**
   * 超时保护：长时间未完成的块强制渲染
   */
  _resetTimer() {
    this._clearTimer();
    this._timer = setTimeout(() => {
      if (this.buffer.trim()) {
        // 超时强制渲染当前缓冲区
        const rendered = renderMarkdown(this.buffer);
        if (rendered) {
          this.onRendered(rendered);
          this._renderedBlocks.push(rendered);
        }
        this.buffer = '';
        this.inFencedCode = false;
        this.codeFence = '';
      }
    }, this.flushTimeout);
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
