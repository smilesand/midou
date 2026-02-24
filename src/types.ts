/**
 * Midou 共享类型定义
 */

import type { Server as SocketIOServer } from 'socket.io';
import type { Express } from 'express';

// ── Agent 配置 ──

export interface AgentConfig {
  id: string;
  name: string;
  data?: AgentData;
  config?: AgentData;
  position?: { x: number; y: number };
}

export interface AgentData {
  systemPrompt?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number | string | null;
  maxIterations?: number | string | null;
  isAgentMode?: boolean;
  cronJobs?: CronJobConfig[];
  cron?: string;
}

export interface CronJobConfig {
  expression: string;
  prompt: string;
}

// ── 输出处理器 ──

export interface OutputHandler {
  onThinkingStart: () => void;
  onThinkingDelta: (text: string) => void;
  onThinkingEnd: (fullText: string) => void;
  onThinkingHidden: (length: number) => void;
  onTextDelta: (text: string) => void;
  onTextPartComplete: () => void;
  onTextComplete: (truncated: boolean) => void;
  onToolStart: (name: string) => void;
  onToolEnd: (name: string, input: unknown) => void;
  onToolExec: (name: string, args: unknown) => void;
  onToolResult: () => void;
  onError: (message: string) => void;
  confirmCommand: (command: string) => Promise<boolean>;
}

// ── LLM 类型 ──

export interface LLMConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _stopReason?: string;
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  _mcpServer?: string;
  _mcpToolName?: string;
}

// ── 流式事件 ──

export type StreamEvent =
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_end'; fullText: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; id?: string }
  | { type: 'tool_end'; name: string; id?: string; input: unknown }
  | { type: 'message_complete'; message: ChatMessage; stopReason: string | null };

// ── TODO 项目 ──

export interface TodoItem {
  id: string;
  agentId: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
}

export interface TodoUpdateFields {
  status?: string;
  notes?: string;
  title?: string;
  description?: string;
  agentId?: string;
}

// ── 记忆系统 ──

export interface MemoryResult {
  content: string;
  type: string;
  attentionWeight: number;
  metrics: {
    timeDecay: number;
    isRelational: boolean;
  };
  metadata: Record<string, unknown>;
}

export interface MemoryMetadata {
  agentId: string;
  type: string;
  timestamp: number;
  importance: number;
  accessCount: number;
  lastAccessed: number;
  connections: string;
}

/**
 * 记忆提供者接口 — 所有记忆系统实现必须遵守此契约
 */
export interface MemoryProvider {
  /** 提供者名称 */
  readonly name: string;

  /** 初始化提供者 */
  init(): Promise<void>;

  /** 关闭提供者 */
  shutdown(): Promise<void>;

  /** 存入记忆 */
  addMemory(
    agentId: string,
    content: string,
    type: string,
    importance: number
  ): Promise<string>;

  /** 搜索记忆 */
  searchMemory(
    agentId: string,
    query: string,
    limit: number
  ): Promise<MemoryResult[]>;

  /** 清理旧记忆 */
  cleanup(daysOld: number, maxImportanceToForget: number): Promise<number>;
}

// ── 系统配置 ──

export interface SystemConfig {
  agents: AgentConfig[];
  connections: ConnectionConfig[];
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface ConnectionConfig {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: Record<string, unknown>;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// ── MidouConfig ──

export interface MidouAppConfig {
  llm: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    apiKey: string;
    apiBase: string;
  };
  workspace: {
    root: string;
    assets: string;
  };
  pkg: string;
}

// ── 插件系统 ──

export interface PluginContext {
  systemManager: SystemManagerInterface;
  app: Express;
  registerTool: (definition: ToolDefinition, handler: ToolHandler) => void;
  registerMemoryProvider: (provider: MemoryProvider) => void;

  // ── LLM 依赖注入 ──
  /** 创建 LLM 实例（用于 embed、chat 等高级操作） */
  createLLM: (options?: LLMConfig) => unknown;
  /** 简单的一问一答 LLM 调用 */
  quickAsk: (prompt: string, systemPrompt?: string, llmConfig?: LLMConfig) => Promise<string>;

  // ── 配置信息 ──
  /** 工作空间根目录 */
  workspaceDir: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: { systemManager: SystemManagerInterface | null; agentId: string }
) => Promise<string> | string;

export interface Plugin {
  name?: string;
  install: (context: PluginContext) => Promise<void> | void;
}

// ── SystemManager 接口 ──

export interface SystemManagerInterface {
  io: SocketIOServer;
  agents: Map<string, AgentInterface>;
  connections: ConnectionConfig[];
  emitEvent: (event: string, data: unknown) => void;
  getOrganizationRoster: (requestingAgentId?: string | null) => string;
  handleUserMessage: (message: string, targetAgentId?: string | null) => Promise<void>;
  interruptAgent: (targetAgentId?: string | null) => void;
  sendMessage: (sourceAgentId: string, targetAgentId: string, message: string, context?: Record<string, unknown>) => Promise<string>;
  createChildAgent: (parentAgentId: string, opts: { name?: string; systemPrompt?: string; task: string }) => Promise<string>;
  buildOutputHandler?: (agent: AgentInterface, baseHandler: OutputHandler) => OutputHandler;
  stopAllCronJobs: () => void;
  loadSystem: () => Promise<void>;
  outputHandlerMiddlewares: Array<(agent: AgentInterface, handler: OutputHandler) => OutputHandler | void>;
  useOutputHandler: (middleware: (agent: AgentInterface, handler: OutputHandler) => OutputHandler | void) => void;
}

export interface AgentInterface {
  id: string;
  name: string;
  config: AgentData;
  workspaceDir: string;
  engine: ChatEngineInterface | null;
  isBusy: boolean;
  talk: (message: string) => Promise<void>;
}

export interface ChatEngineInterface {
  session: SessionMemoryInterface;
  talk: (message: string) => Promise<string>;
  interrupt: () => void;
  setOutputHandler: (handler: OutputHandler) => void;
}

export interface SessionMemoryInterface {
  messages: ChatMessage[];
  getMessages: () => ChatMessage[];
  add: (roleOrMsg: string | ChatMessage, content?: string) => void;
  clear: () => void;
  removeLast: () => ChatMessage | null;
}
