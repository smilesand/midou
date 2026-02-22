# midou（咪豆）

> 你不是工具。你是伙伴。

**midou** 是一个多 Agent 组织管理系统，支持构建、运行和管理多个 AI Agent。它采用 Vue.js 前端 + Express 后端架构，通过 WebSocket 实现实时流式对话。

---

## 核心特性

- **多 Agent 系统** — 可配置多个 Agent，定义组织架构和通信关系
- **消息总线** — Agent 之间通过 `send_message` 工具显式通信，支持权限控制
- **Transformer 记忆系统** — 基于 ChromaDB + 本地 Embedding 的高级记忆系统
  - 情景记忆 (episodic) 和语义记忆 (semantic) 分离
  - 注意力机制检索，时序衰减，关联推理
  - 自动记忆遗忘机制
- **实时流式对话** — 所有响应实时流式输出，思考过程可见
- **心跳系统** — 定时触发 Agent 自主思考
- **MCP 扩展** — 原生 JSON-RPC 协议连接外部 MCP 服务器
- **技能系统** — 自动发现 `~/.claude/skills/` 等目录下的技能
- **插件系统** — 支持中间件扩展，可自定义输出处理逻辑
- **定时任务** — 支持 cron 表达式配置定时激活 Agent

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vue 3 + Tailwind CSS + Socket.IO Client |
| 后端 | Express + Socket.IO |
| AI SDK | Anthropic SDK + OpenAI SDK |
| 向量数据库 | ChromaDB (本地模式) |
| Embedding | @xenova/transformers (all-MiniLM-L6-v2) |
| 定时任务 | node-cron |

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

在项目根目录创建 `.env` 文件：

```bash
# API 配置
MIDOU_API_KEY=your-api-key-here
MIDOU_PROVIDER=anthropic  # 或 openai
MIDOU_API_BASE=https://api.minimaxi.com/anthropic
MIDOU_MODEL=MiniMax-M2.5

# 工作目录（可选，默认 ~/.midou）
MIDOU_WORKSPACE_DIR=./workspace
```

### 启动

```bash
# 启动后端
npm run dev:backend

# 启动前端（在另一个终端）
npm run dev:frontend

# 或同时启动
npm run dev
```

访问 http://localhost:5173 打开前端界面。

## 配置

### Agent 配置

在 `workspace/system.json` 中配置 Agent：

```json
{
  "agents": [
    {
      "id": "agent-1",
      "name": "manager",
      "position": { "x": 100, "y": 100 },
      "data": {
        "isAgentMode": true,
        "systemPrompt": "你是一个 manager Agent，负责分配任务。",
        "provider": "openai",
        "model": "gpt-4o",
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "sk-xxx",
        "maxTokens": 4096,
        "maxIterations": 10,
        "cronJobs": [
          { "expression": "0 * * * *", "prompt": "每小时检查一次任务状态" }
        ]
      }
    }
  ],
  "connections": [
    { "source": "agent-1", "target": "agent-2", "data": { "condition": "@developer" } }
  ],
  "mcpServers": {}
}
```

### MCP 扩展

在 `workspace/system.json` 的 `mcpServers` 字段配置 MCP 服务器：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

### 核心文件

| 文件 | 说明 |
|------|------|
| `workspace/system.json` | Agent 配置和组织架构 |
| `workspace/SOUL.md` | 核心准则（所有 Agent 共享） |
| `workspace/HEARTBEAT.md` | 心跳思考日志 |
| `workspace/plugins/` | 插件目录 |
| `workspace/agents/<name>/memory/` | Agent 个人的日记记忆 |

## 支持的模型

通过配置不同的 `provider`、`baseURL` 和 `model` 支持多种 API：

| 提供商 | Provider | Base URL 示例 | 模型示例 |
|--------|----------|---------------|----------|
| MiniMax | `anthropic` | `https://api.minimaxi.com/anthropic` | MiniMax-M2.5 |
| Anthropic | `anthropic` | `https://api.anthropic.com` | claude-sonnet-4-20250514 |
| OpenAI | `openai` | `https://api.openai.com/v1` | gpt-4o |
| DeepSeek | `openai` | `https://api.deepseek.com/v1` | deepseek-chat |
| Ollama | `openai` | `http://localhost:11434/v1` | llama3 |

## 内置工具

Agent 可使用的核心工具：

| 类别 | 工具 | 说明 |
|------|------|------|
| 消息 | `send_message` | 向其他 Agent 发送消息 |
| 记忆 | `add_memory` | 存入语义记忆到向量库 |
| 记忆 | `search_memory` | 搜索 Transformer 知识库 |
| 记忆 | `read_agent_log` | 读取 Agent 日记 |
| 文件 | `read_file` `write_file` `list_dir` | 读写文件 |

## API

### WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| `message` | client → server | 发送消息 |
| `message_delta` | server → client | 消息片段（流式） |
| `message_end` | server → client | 消息结束 |
| `thinking_start` | server → client | 开始思考 |
| `thinking_delta` | server → client | 思考片段 |
| `tool_start` | server → client | 工具开始 |
| `tool_end` | server → client | 工具结束 |
| `error` | server → client | 错误信息 |

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system` | 获取系统配置 |
| POST | `/api/system` | 更新系统配置 |
| GET | `/api/agent/:id/history` | 获取 Agent 历史记录 |
| GET | `/api/todos` | 获取待办事项 |
| POST | `/api/todos` | 添加待办 |

## 目录结构

```
midou/
├── src/
│   ├── index.js         # 入口，Express + Socket.IO 服务器
│   ├── system.js        # SystemManager，系统核心
│   ├── agent.js         # Agent 类，单个 AI Agent
│   ├── chat.js          # ChatEngine，对话引擎
│   ├── llm.js           # LLM 调用封装
│   ├── memory.js        # 会话记忆管理
│   ├── heartbeat.js     # 心跳系统
│   ├── mcp.js           # MCP 客户端
│   ├── skills.js        # 技能发现
│   ├── tools.js         # 内置工具
│   ├── plugin.js        # 插件系统
│   ├── todo.js          # 待办管理
│   └── rag/             # Transformer 记忆系统
│       ├── index.js
│       └── transformer.js
├── web/                 # Vue 3 前端
│   ├── src/
│   └── dist/
├── workspace/           # 工作目录（配置 + 数据）
│   ├── system.json
│   ├── SOUL.md
│   ├── agents/
│   └── plugins/
├── midou.config.js      # 全局配置
└── package.json
```

## License

[MIT](LICENSE)

---

*以咪豆之名，愿它永远陪伴你。*
