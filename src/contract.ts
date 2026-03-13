/**
 * Contract Parser — @api-contract 注解解析器
 *
 * 从 TypeScript 文件中提取结构化的 API 契约定义。
 * 契约注解使用 JSDoc 风格声明，统一开发多方协作的接口规范。
 */

import fs from 'fs/promises';
import path from 'path';
import type { ParsedContract, ContractField, ContractResponse } from './types.js';

/**
 * 匹配完整的 @api-contract 注解块（从 /** @api-contract 到 *​/）
 */
const CONTRACT_BLOCK_RE = /\/\*\*[\s\S]*?@api-contract[\s\S]*?\*\//g;

/**
 * 解析单个注解块中的键值标签
 */
function parseTag(block: string, tag: string): string {
  const re = new RegExp(`@${tag}\\s+(.+?)(?=\\n\\s*\\*\\s*@|\\n\\s*\\*\\/|$)`, 's');
  const m = block.match(re);
  return m ? m[1].replace(/\n\s*\*\s*/g, ' ').trim() : '';
}

/**
 * 解析多行的 field 列表（requestBody / response fields）
 * 格式: - fieldName {type} [required] description
 */
function parseFields(text: string): ContractField[] {
  const fields: ContractField[] = [];
  const lines = text.split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^-\s+(\w+)\s+\{(\w+)\}\s*(\[required\])?\s*(.*)/);
    if (m) {
      fields.push({
        name: m[1],
        type: m[2],
        required: m[3] === '[required]',
        description: m[4].trim(),
      });
    }
  }
  return fields;
}

/**
 * 解析 @response 块（可能有多个）
 */
function parseResponses(block: string): ContractResponse[] {
  const results: ContractResponse[] = [];
  const re = /@response\s+(\d+)\s*(.*?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/gs;
  let m: RegExpExecArray | null;

  while ((m = re.exec(block)) !== null) {
    const statusCode = parseInt(m[1], 10);
    const rest = m[2].replace(/\n\s*\*\s*/g, '\n').trim();
    const lines = rest.split('\n');
    const description = lines[0] || '';
    const fieldLines = lines.slice(1).join('\n');

    results.push({
      statusCode,
      description: description.trim(),
      fields: fieldLines ? parseFields(fieldLines) : undefined,
    });
  }
  return results;
}

/**
 * 解析 @mockData（JSON 格式）
 */
function parseMockData(block: string): Record<string, unknown> | undefined {
  const re = /@mockData\s+([\s\S]*?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/;
  const m = block.match(re);
  if (!m) return undefined;

  const raw = m[1].replace(/\n\s*\*\s?/g, '\n').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * 解析 @serverHint（多行列表）
 */
function parseServerHints(block: string): string[] | undefined {
  const re = /@serverHint\s+([\s\S]*?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/;
  const m = block.match(re);
  if (!m) return undefined;

  return m[1]
    .replace(/\n\s*\*\s?/g, '\n')
    .trim()
    .split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

/**
 * 解析单个 @api-contract 注解块为 ParsedContract
 */
function parseContractBlock(block: string): ParsedContract {
  const module = parseTag(block, 'module');
  const endpoint = parseTag(block, 'endpoint');
  const method = parseTag(block, 'method');
  const pathStr = parseTag(block, 'path');
  const summary = parseTag(block, 'summary');
  const description = parseTag(block, 'description');
  const permission = parseTag(block, 'permission');

  // requestBody — 解析其后的 field 列表
  const rbRe = /@requestBody\s+([\s\S]*?)(?=\n\s*\*\s*@(?!requestBody)|\n\s*\*\/|$)/;
  const rbMatch = block.match(rbRe);
  const requestBody = rbMatch ? parseFields(rbMatch[1]) : undefined;

  const responses = parseResponses(block);
  const mockData = parseMockData(block);
  const serverHints = parseServerHints(block);

  return {
    module,
    endpoint,
    method: method.toUpperCase() || 'GET',
    path: pathStr,
    summary,
    description,
    permission,
    requestBody: requestBody && requestBody.length > 0 ? requestBody : undefined,
    responses,
    mockData,
    serverHints,
    raw: block,
  };
}

/**
 * 从单个文件中提取所有 @api-contract
 */
export function parseContractsFromSource(source: string): ParsedContract[] {
  const blocks = source.match(CONTRACT_BLOCK_RE);
  if (!blocks) return [];
  return blocks.map(parseContractBlock);
}

/**
 * 递归扫描目录，提取所有 .ts / .js 文件中的 @api-contract
 */
export async function parseContractsFromDir(dir: string): Promise<ParsedContract[]> {
  const results: ParsedContract[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 node_modules / .git 等
        if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
        await walk(fullPath);
      } else if (/\.(ts|js|tsx|jsx)$/.test(entry.name)) {
        try {
          const source = await fs.readFile(fullPath, 'utf-8');
          const contracts = parseContractsFromSource(source);
          results.push(...contracts);
        } catch {
          // 跳过无法读取的文件
        }
      }
    }
  }

  await walk(dir);
  return results;
}
