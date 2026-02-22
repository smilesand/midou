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
  - 自动记忆遗忘机制（每日凌晨 3 点清理低重要性旧记忆）
- **实时流式对话** — 所有响应实时流式输出，思考过程可见
- **心跳系统** — 定时触发全局反省，自动提取长期记忆，执行待办任务
- **MCP 扩展** — 原生 JSON-RPC 协议连接外部 MCP 服务器
- **技能系统** — 自动发现 `~/.claude/skills/` 等目录下的技能
- **插件系统** — 支持自定义工具、API 路由、输出中间件
- **定时任务** — 支持 cron 表达式配置定时激活 Agent
- **TODO 管理** — 内置待办事项系统，Agent 可自主创建和更新任务

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vue 3 + Tailwind CSS + Socket.IO Client + Vue Flow |
| 后端 | Express 5 + Socket.IO |
| AI SDK | Anthropic SDK + OpenAI SDK |
| 向量数据库 | ChromaDB (本地自动启动) |
| Embedding | @xenova/transformers (all-MiniLM-L6-v2, 384 维) |
| 定时任务 | node-cron |

## 快速开始

### 安装依赖

```bash
npm install
cd web && npm install
```

### 配置环境变量

在工作目录（默认 `~/.midou`）下创建 `.env` 文件：

```bash
# API 配置
MIDOU_API_KEY=your-api-key-here
MIDOU_PROVIDER=anthropic  # 或 openai
MIDOU_API_BASE=https://api.minimaxi.com/anthropic
MIDOU_MODEL=MiniMax-M2.5

# 工作目录（可选，默认 ~/.midou）
# MIDOU_WORKSPACE_DIR=/custom/path
```

也可在项目根目录放置 `.env`，但工作目录下的 `.env` 优先加载。

### 启动

```bash
# 启动后端（含 ChromaDB 自动启动）
npm run dev:backend

# 启动前端开发服务器（在另一个终端）
npm run dev:frontend

# 或同时启动
npm run dev

# 构建前端
npm run build
```

后端运行在 `http://localhost:3000`，前端开发服务器在 `http://localhost:5173`（自动代理到后端）。

## 配置

### 工作目录结构

默认工作目录为 `~/.midou`，可通过 `MIDOU_WORKSPACE_DIR` 环境变量自定义：

```
~/.midou/
├── system.json              # Agent 配置和组织架构
├── SOUL.md                  # 核心准则（所有 Agent 共享）
├── HEARTBEAT.md             # 心跳反省策略（可由 Agent 自行修改）
├── .env                     # 环境变量
├── chroma_data/             # ChromaDB 向量数据（自动生成）
├── agents/
│   └── <name>/
│       └── memory/
│           └── YYYY-MM-DD.md  # Agent 日记
├── plugins/
│   └── <plugin-name>/
│       ├── package.json     # 需包含 "type": "module"
│       └── index.js         # 插件入口
└── todos.json               # 待办事项数据
```

### Agent 配置

在工作目录的 `system.json` 中配置 Agent（也可通过前端 Graph Editor 可视化编辑）：

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
    {
      "source": "agent-1",
      "target": "agent-2",
      "sourceHandle": "right-source",
      "targetHandle": "left-target"
    }
  ],
  "mcpServers": {}
}
```

**Agent `data` 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `isAgentMode` | boolean | 是否启用 Agent 模式（循环调用工具），默认 `true` |
| `systemPrompt` | string | 系统提示词 |
| `provider` | string | LLM 提供商：`anthropic` 或 `openai` |
| `model` | string | 模型名称 |
| `baseURL` | string | API 基础 URL |
| `apiKey` | string | API Key（可选，默认使用全局配置） |
| `maxTokens` | number | 最大 token 数 |
| `maxIterations` | number | Agent 模式最大工具调用轮次（默认 30） |
| `cronJobs` | array | 定时任务列表 |

### MCP 扩展

在 `system.json` 的 `mcpServers` 字段配置 MCP 服务器：

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

MCP 工具会自动注册为 Agent 可调用的工具。

### 心跳系统

心跳系统默认每 60 分钟执行一次全局反省（活跃时间 8:00-23:00）：

1. 检查每个 Agent 的待办任务，有未完成的自动触发执行
2. 读取 Agent 今日对话日记
3. 根据 `HEARTBEAT.md` 策略调用 LLM 生成长期记忆
4. 将长期记忆存入 ChromaDB 向量库

`HEARTBEAT.md` 是心跳的反省策略模板，Agent 可通过工具修改以调整关注重点。

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
| 流程 | `finish_task` | 结束当前任务（Agent 模式下） |
| 流程 | `ask_user` | 向用户提问并等待回答 |
| 消息 | `send_message` | 向其他 Agent 发送消息（需有连线权限） |
| 消息 | `read_organization_roster` | 查看组织花名册 |
| 记忆 | `add_memory` | 存入语义记忆到向量库 |
| 记忆 | `search_memory` | 搜索 Transformer 知识库 |
| 记忆 | `read_agent_log` | 读取 Agent 日记日志 |
| 文件 | `read_system_file` | 读取工作目录中的文件 |
| 文件 | `write_system_file` | 写入工作目录中的文件 |
| 文件 | `list_system_dir` | 列出工作目录中的目录内容 |
| 系统 | `run_command` | 执行 shell 命令（需用户确认） |
| 技能 | `list_skills` | 列出可用技能 |
| 技能 | `load_skill` | 加载并读取指定技能 |
| 待办 | `update_todo` | 更新待办事项状态和备注 |
| 待办 | `list_todos` | 列出所有待办事项 |

插件可通过 `registerTool()` 注册额外工具。

## 插件系统

插件存放在工作目录的 `plugins/` 下，每个插件是一个目录，包含 `index.js` 入口文件和 `package.json`。

```javascript
// plugins/my-plugin/index.js
export default {
  name: 'my-plugin',
  install({ systemManager, app, registerTool }) {
    // 1. registerTool(schema, handler) — 注册 Agent 可调用的工具
    // 2. app.get('/api/plugins/...') — 注册自定义 API 路由
    // 3. systemManager.useOutputHandler(middleware) — 拦截 Agent 输出流
    // 4. systemManager.io — 监听 Socket.IO 事件
  }
};
```

**注意：** 插件的 `package.json` 必须包含 `"type": "module"`。

## API

### WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| `message` | client → server | 发送消息 `{ content, targetAgentId }` |
| `interrupt` | client → server | 中断 Agent `{ targetAgentId }` |
| `message_delta` | server → client | 文本片段（流式） |
| `message_end` | server → client | 消息结束 `{ agentId, fullText }` |
| `thinking_start` | server → client | 开始思考 |
| `thinking_delta` | server → client | 思考片段 |
| `thinking_end` | server → client | 思考结束 |
| `thinking_hidden` | server → client | 隐藏的思考（返回长度） |
| `tool_start` | server → client | 工具开始调用 `{ agentId, name }` |
| `tool_end` | server → client | 工具调用结束 `{ agentId, name, input }` |
| `tool_exec` | server → client | 工具正在执行 `{ agentId, name }` |
| `tool_result` | server → client | 工具返回结果 |
| `agent_busy` | server → client | Agent 开始处理 |
| `agent_idle` | server → client | Agent 处理完毕 |
| `system_message` | server → client | 系统消息 |
| `error` | server → client | 错误信息 |

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system` | 获取系统配置 |
| POST | `/api/system` | 更新系统配置（自动重载） |
| GET | `/api/agent/:id/history` | 获取 Agent 对话历史 |
| GET | `/api/todos` | 获取所有待办事项 |
| POST | `/api/todos` | 添加待办 `{ agentId, title, description }` |
| PUT | `/api/todos/:id` | 更新待办状态 |
| DELETE | `/api/todos/:id` | 删除待办 |

## 目录结构

```
midou/
├── src/
│   ├── index.js          # 入口，Express + Socket.IO 服务器
│   ├── system.js         # SystemManager，系统核心
│   ├── agent.js          # Agent 类，单个 AI Agent
│   ├── chat.js           # ChatEngine，对话引擎（支持 Agent 循环）
│   ├── llm.js            # LLM 调用封装（Anthropic / OpenAI）
│   ├── memory.js         # 会话记忆 + 日记日志
│   ├── heartbeat.js      # 心跳反省系统
│   ├── mcp.js            # MCP 客户端（JSON-RPC over stdio）
│   ├── skills.js         # 技能发现与加载
│   ├── tools.js          # 内置工具定义与执行
│   ├── plugin.js         # 插件加载器
│   ├── todo.js           # 待办事项管理
│   └── rag/              # Transformer 记忆系统
│       ├── index.js      # 公共 API
│       └── transformer.js # ChromaDB + Embedding 核心
├── web/                  # Vue 3 前端
│   ├── src/
│   │   ├── views/
│   │   │   ├── ChatView.vue      # 聊天界面
│   │   │   └── GraphEditor.vue   # 可视化 Agent 编辑器
│   │   └── router/
│   └── dist/             # 前端构建输出
├── midou.config.js       # 全局配置（路径、LLM 默认值）
└── package.json
```

## License

[MIT](LICENSE)

---

*以咪豆之名，愿它永远陪伴你。*
