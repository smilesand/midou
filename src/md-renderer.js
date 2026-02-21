/**
 * 增量 Markdown 渲染器 — 流式输出的 Markdown 实时渲染
 *
 * 核心算法：
 *   1. 缓冲区累积流式文本块
 *   2. 使用 marked.lexer 解析缓冲区，检测完整的 markdown 块
 *   3. 完整块立即通过 marked-terminal 渲染输出
 *   4. 未完成的块保留在缓冲区等待更多内容
 *   5. 流结束时 flush 剩余内容
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// 配置 marked 使用终端渲染器
marked.use(
  markedTerminal({
    width: 80,
    reflowText: true,
    tab: 2,
    emoji: true,
    showSectionPrefix: false, // 不显示原始的 # 前缀
  })
);

// 自定义链接和标题渲染
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      const headingText = tokens ? this.parser.parseInline(tokens) : text;
      // 根据层级添加不同的前缀符号，使其在终端中更像标题
      const prefix = depth === 1 ? '█ ' : depth === 2 ? '▓ ' : depth === 3 ? '▒ ' : '░ ';
      const styledText = `\x1b[1m${prefix}${headingText}\x1b[0m`;
      
      // 根据层级添加颜色
      if (depth === 1) return `\x1b[35m${styledText}\x1b[39m\n\n`; // Magenta
      if (depth === 2) return `\x1b[32m${styledText}\x1b[39m\n\n`; // Green
      if (depth === 3) return `\x1b[33m${styledText}\x1b[39m\n\n`; // Yellow
      return `\x1b[36m${styledText}\x1b[39m\n\n`; // Cyan
    },
    link({ href, tokens, text }) {
      const linkText = tokens ? this.parser.parseInline(tokens) : text;
      if (linkText === href) {
        return `\x1b[4m\x1b[36m${href}\x1b[0m`;
      }
      return `\x1b[36m${linkText}\x1b[0m (\x1b[4m\x1b[90m${href}\x1b[0m)`;
    },
  },
});

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
   */
  constructor(onRendered) {
    this.onRendered = onRendered;
    this.buffer = '';
    this._renderedBlocks = [];  // 已渲染块的记录
  }

  /**
   * 喂入一个文本块
   */
  feed(chunk) {
    this.buffer += chunk;
    this._tryExtractBlocks();
  }

  /**
   * 流结束，强制渲染所有剩余内容
   */
  flush() {
    if (this.buffer.trim()) {
      const rendered = renderMarkdown(this.buffer);
      if (rendered) {
        this.onRendered(rendered);
        this._renderedBlocks.push(rendered);
      }
      this.buffer = '';
    }
  }

  /**
   * 重置渲染器状态
   */
  reset() {
    this.buffer = '';
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
   */
  _tryExtractBlocks() {
    const tokens = marked.lexer(this.buffer);
    
    if (tokens.length <= 1) {
      return; // 等待更多内容
    }

    // 除了最后一个 token，其他都是完整的块
    const completeTokens = tokens.slice(0, -1);
    const lastToken = tokens[tokens.length - 1];

    for (const token of completeTokens) {
      // 忽略纯空白 token
      if (token.type === 'space') continue;
      
      const rendered = renderMarkdown(token.raw);
      if (rendered) {
        this.onRendered(rendered);
        this._renderedBlocks.push(rendered);
      }
    }

    // 保留最后一个未完成的 token 在缓冲区
    this.buffer = lastToken.raw;
  }
}
