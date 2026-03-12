# file-watchdog

增量文件监控插件 — 多层数据流水线，从海量文件事件到结构化风险报告。

## 架构

```
Layer 0  @parcel/watcher 增量快照  →  raw-events.jsonl
Layer 1  事件分类 + 大规模操作检测  →  bulk-operations.jsonl / git-operations.jsonl
Layer 2  @huggingface/transformers  →  local-summaries.jsonl（本地离线摘要）
Layer 3  增量日志写入               →  timeline.md
Layer 4  定期 Agent LLM 分析        →  agent-reports.jsonl（每 4 小时）
Layer 5  每日 05:40 汇总            →  daily-report.md → Socket.IO 推送前端
```

## 工具

| 工具 | 说明 |
|------|------|
| `watchdog_create_watch_task` | 创建目录监控任务（自动增量记录 + 大规模操作检测 + Git 追踪） |
| `watchdog_list_watch_tasks` | 列出监控任务 |
| `watchdog_run_watch_task_once` | 立即执行一次 |
| `watchdog_stop_watch_task` | 停止任务（保留配置） |
| `watchdog_delete_watch_task` | 永久删除任务 |
| `watchdog_get_report` | 获取指定日期报告（默认今天） |
| `watchdog_trigger_analysis` | 手动触发 Agent 分析 |
| `watchdog_generate_daily_report` | 手动生成每日汇总报告 |

## 输出位置

```
workspace/logs/watchdog/YYYY-MM-DD/
  ├── raw-events.jsonl          # Layer 0: 原始增量事件
  ├── bulk-operations.jsonl     # Layer 1: 大规模操作（用户/时间/事件/文件数）
  ├── git-operations.jsonl      # Layer 1: Git 操作（用户/时间/分支/提交/diff）
  ├── local-summaries.jsonl     # Layer 2: HuggingFace 本地摘要
  ├── timeline.md               # Layer 3: 人可读增量时间线
  ├── agent-reports.jsonl       # Layer 4: Agent 分时段分析报告
  └── daily-report.md           # Layer 5: 每日汇总报告
```

## 大规模操作检测

自动识别以下操作并记录用户、时间、事件：

- **依赖管理**：npm install / pnpm install / yarn / rm node_modules
- **系统包管理**：yay -Scc / pacman -Scc / apt clean
- **构建产物**：build / test / coverage 输出
- **缓存清理**：npm cache clean / .cache 变更

## Git 操作追踪

自动识别并记录用户、时间、分支、提交信息：

- `git clone` — 大量 objects + packed-refs
- `git checkout / switch` — HEAD 改变
- `git branch` — 分支创建/删除
- `git commit` — objects 增加 + diff 统计
- `git fetch / pull` — 远程 refs 更新
- `git push` — refs 变更

提交信息包含 `git diff --stat` 输出的变更概要。

## 本地摘要

使用 `@huggingface/transformers` 的 `Xenova/distilbart-cnn-6-6` 模型进行离线摘要：

- 不将原始数据直接发送给大模型
- 首次加载模型后缓存，后续推理速度快
- 加载失败时自动降级为规则摘要

## 定时任务

| 任务 | 间隔 | 说明 |
|------|------|------|
| 增量快照 | 用户设定 | 按任务周期执行 |
| Agent 分析 | 4 小时 | 分析自上次以来的新增数据，增量追加报告 |
| 每日汇总 | 05:40 | 生成含 Mermaid 图表的完整日报，推送前端 |

## 前端事件

- `watchdog:daily-report` — 每日报告推送，包含 `day`、`report`、`stats`、`generatedAt`

## Agent 提示词

参考 `agent-prompt.md`。