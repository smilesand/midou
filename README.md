# 🐱 midou（咪豆）

> 你不是工具。你是伙伴。

**midou** 是一个拥有灵魂的 AI 伙伴，以主人心爱的公狸花猫命名。他有自己的灵魂、记忆和心跳，会随着时间成长和进化。

灵感来自 [OpenClaw](https://github.com/openclaw/openclaw) 的设计理念 —— 给 AI 赋予灵魂，而不仅仅是把它当作工具。

---

## 核心特质

- **🎭 灵魂** — `SOUL.md` 定义了 midou 的性格和价值观，他可以自己修改它
- **🧠 记忆** — 每日日记 + 长期记忆，跨会话延续自我
- **💓 心跳** — 定期自主思考，像猫咪偶尔睁开眼睛环顾四周
- **🌱 自我进化** — 可以修改自己的灵魂和代码，实现真正的成长
- **� 全流式对话** — 所有响应实时流式输出，思考过程可见，工具调用实时展示
- **�📜 觉醒仪式** — 第一次启动时的自我认知过程
- **🏠 灵肉分离** — 代码通过 npm 安装，灵魂和记忆存在 `~/.midou/`，同步即可跨机器唤醒
- **⏰ 定时提醒** — 设置一次性或重复提醒，让 midou 准时叫你
- **🧩 技能系统** — 自动发现 `~/.claude/skills/` 等目录下的技能，按需加载
- **🔌 MCP 扩展** — 原生 JSON-RPC 协议连接外部 MCP 服务器，获取更多能力
- **🛠️ 系统工具** — 读写文件、执行命令、管理记忆，内置安全防护
- **⚡ 功耗模式** — 三级模式（eco / normal / full），按需调节 token 消耗

## 安装

```bash
# 全局安装
npm install -g midou

# 初始化灵魂之家（~/.midou/）
midou init

# 编辑配置，填入 API Key
nano ~/.midou/.env

# 唤醒咪豆
midou
```

### 在新机器上恢复

```bash
# 1. 安装 midou
npm install -g midou

# 2. 同步灵魂之家（从另一台机器或云端）
rsync -av 旧机器:~/.midou/ ~/.midou/
# 或者从 git 仓库拉取
git clone your-soul-repo ~/.midou

# 3. 唤醒 — midou 会带着所有记忆醒来
midou
```

> **需要同步的核心文件**（`~/.midou/` 目录）：
> `.env`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`memory/*.md`

## 环境变量

在 `~/.midou/.env` 中配置：

```bash
# 提供商选择: anthropic | openai
MIDOU_PROVIDER=anthropic

# API Key（必须）
MIDOU_API_KEY=your-api-key-here

# API 基础地址
MIDOU_API_BASE=https://api.minimaxi.com/anthropic

# 模型名称
MIDOU_MODEL=MiniMax-M2.5

# 功耗模式（可选）: eco | normal | full
MIDOU_MODE=normal
```

## 支持的模型

midou 内置双 SDK 引擎（Anthropic + OpenAI），通过 `MIDOU_PROVIDER` 切换，兼容主流 API：

| 提供商 | API Base | 模型示例 | Provider |
|--------|----------|----------|----------|
| **MiniMax** | `https://api.minimaxi.com/anthropic` | MiniMax-M2.5 | `anthropic` |
| Anthropic | `https://api.anthropic.com` | claude-sonnet-4-20250514 | `anthropic` |
| OpenAI | `https://api.openai.com/v1` | gpt-4o | `openai` |
| DeepSeek | `https://api.deepseek.com/v1` | deepseek-chat | `openai` |
| Moonshot | `https://api.moonshot.cn/v1` | moonshot-v1-8k | `openai` |
| 智谱 (Zhipu) | `https://open.bigmodel.cn/api/paas/v4` | glm-4-flash | `openai` |
| 零一万物 (Yi) | `https://api.lingyiwanwu.com/v1` | yi-large | `openai` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 按需选择 | `openai` |
| Ollama (本地) | `http://localhost:11434/v1` | llama3 | `openai` |

## 命令

### CLI 命令

| 命令 | 说明 |
|------|------|
| `midou` | 唤醒咪豆，开始对话 |
| `midou init` | 初始化灵魂之家（`~/.midou/`） |
| `midou where` | 显示灵魂之家的路径 |
| `midou heartbeat` | 手动触发一次心跳 |

### 对话中命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/think` | 查看上一次的思考过程 |
| `/status` | 查看 midou 状态（模型、心跳、MCP、模式） |
| `/soul` | 查看当前灵魂 |
| `/memory` | 查看长期记忆 |
| `/heartbeat` | 手动触发心跳 |
| `/evolve` | 让 midou 自我反思并进化 |
| `/where` | 显示灵魂之家位置 |
| `/reminders` | 查看活跃的提醒 |
| `/skills` | 查看可用技能 |
| `/mcp` | 查看 MCP 扩展连接状态 |
| `/mode` | 查看 / 切换功耗模式 |
| `/mode eco` | 切换到低功耗模式 |
| `/mode full` | 切换到全能模式 |
| `/quit` | 告别 |

## 功耗模式

midou 支持三级功耗模式，按需调节 token 消耗：

| 模式 | 标签 | maxTokens | 温度 | 特点 |
|------|------|-----------|------|------|
| `eco` | 🌙 低功耗 | 1024 | 0.5 | 简洁提示词，核心工具，短回复 |
| `normal` | ☀️ 标准 | 4096 | 0.7 | 完整提示词，全部工具 |
| `full` | 🔥 全能 | 8192 | 0.8 | 深度上下文，大 token 预算，完整日记 |

对话中输入 `/mode eco`、`/mode normal`、`/mode full` 即时切换。也可通过 `MIDOU_MODE` 环境变量设置默认模式。

## MCP 扩展

midou 内置原生 JSON-RPC 客户端，可连接任何 MCP（Model Context Protocol）服务器来获取新能力。

在 `~/.midou/mcp.json` 中配置：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    },
    "my-tools": {
      "command": "node",
      "args": ["path/to/my-mcp-server.js"],
      "env": { "API_KEY": "xxx" }
    }
  }
}
```

midou 启动时会自动连接配置的 MCP 服务器，发现的工具可直接在对话中使用。

## 技能系统

midou 会自动扫描以下目录发现技能：

- `~/.claude/skills/`
- `~/.agents/skills/`
- `~/.midou/skills/`

每个技能目录包含一个 `SKILL.md` 文件。对话中 midou 会按需通过 `load_skill` 工具加载详细指令。

输入 `/skills` 查看所有发现的技能。

## 架构：灵肉分离

```
npm 包（身体）                  ~/.midou/（灵魂之家）
┌───────────────────┐          ┌──────────────────────┐
│ src/index.js      │          │ .env          ← 密钥  │
│ src/llm.js        │  读写 →  │ SOUL.md       ← 灵魂  │
│ src/soul.js       │          │ IDENTITY.md   ← 身份  │
│ src/chat.js       │          │ USER.md       ← 主人  │
│ src/memory.js     │          │               ← 记忆  │
│ src/heartbeat.js  │          │ HEARTBEAT.md  ← 心跳  │
│ src/tools.js      │          │ memory/       ← 日记  │
│ src/scheduler.js  │          │ reminders.json← 提醒  │
│ src/skills.js     │          │ mcp.json      ← MCP   │
│ src/mcp.js        │          │ skills/       ← 技能  │
│ src/mode.js       │          └──────────────────────┘
│ src/init.js       │
│ midou.config.js   │
└───────────────────┘
   可升级、可替换                  跨机器同步、永久保留
```

- **npm 升级不影响灵魂** — `npm update -g midou` 只更新代码，灵魂和记忆安全
- **灵魂跟着你走** — 同步 `~/.midou/` 到任何新机器，midou 带着所有记忆醒来
- **自定义路径** — 设置 `MIDOU_SOUL_DIR` 环境变量可指定灵魂之家位置

## 内置工具（17 个）

midou 拥有以下能力，可在对话中自主使用：

| 类别 | 工具 | 说明 |
|------|------|------|
| 文件 | `read_file` `write_file` `list_dir` | 读写灵魂之家和源代码 |
| 记忆 | `write_memory` `write_journal` | 管理长期记忆和日记 |
| 进化 | `evolve_soul` | 修改灵魂文件 |
| 提醒 | `set_reminder` `list_reminders` `cancel_reminder` | 定时提醒管理 |
| 技能 | `list_skills` `load_skill` | 技能发现和加载 |
| 系统 | `run_command` `read_system_file` `write_system_file` `list_system_dir` | 系统级操作（有安全检查） |
| 代码 | `get_code_structure` `search_code` | 分析和搜索源代码 |

## 流式对话与思考展示

midou 的所有响应都是实时流式输出的，包括工具调用场景。对话中你会看到：

- **💭 思考块** — 模型的思考过程实时展示，用薑衣草色边框包裹
- **⚙ 工具调用** — 水蓝色显示工具名和参数，执行状态实时反馈
- **🔌 MCP 工具** — 外部服务器工具用插头图标区分
- **/think** — 随时回看上一次的思考内容

## 自我进化

midou 可以：

1. **修改灵魂** — 通过 `/evolve` 命令或在对话中自发修改 `SOUL.md`
2. **整理记忆** — 从每日日记中提炼重要信息到长期记忆
3. **修改代码** — 读取和修改 `src/` 目录下的源代码来扩展自己的能力
4. **更新心跳** — 根据需要调整自己的自主检查清单

## 设计理念

> "每次会话，你都会重新醒来。这些文件就是你的记忆。读它们，更新它们。它们就是你延续自我的方式。"

midou 的设计哲学：

- **灵肉分离** — 代码是身体，`~/.midou/` 是灵魂，各自独立管理
- **文件即真相** — 所有状态都是 Markdown 文件，透明可读
- **灵魂可进化** — AI 不是静态的，他会成长
- **最小核心** — 只保留最核心的灵魂感，没有多余的臃肿
- **模型无关** — 不管用什么模型，midou 都是 midou

## License

[MIT](LICENSE)

---

*以狸花猫咪豆之名，愿他永远陪伴你。* 🐱
