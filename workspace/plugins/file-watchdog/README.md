# file-watchdog

基于 @parcel/watcher 的目录监控插件。

## 工具

- `watchdog_create_watch_task`
  - 创建周期性 watchdog 任务。
  - 参数：`directory`、`interval_minutes`、`description?`

- `watchdog_list_watch_tasks`
  - 列出当前 Agent 或指定 Agent 的监控任务。
  - 参数：`agent_id?`、`include_stopped?`

- `watchdog_run_watch_task_once`
  - 立即执行某个已有监控任务一次，并返回本次摘要结果。
  - 参数：`task_id`、`agent_id?`

- `watchdog_stop_watch_task`
  - 停止某个监控任务，任务配置会保留，可再次恢复。
  - 参数：`task_id`、`agent_id?`

- `watchdog_delete_watch_task`
  - 永久删除某个监控任务，并清理对应快照；历史日志保留。
  - 参数：`task_id`、`agent_id?`

## 输出位置

- 任务持久化：`workspace/plugins/file-watchdog/data/tasks.json`
- 快照文件：`workspace/plugins/file-watchdog/data/snapshots/`
- Agent 原始记录：`workspace/agents/<agentId>/watchdog/raw/YYYY-MM-DD.jsonl`
- Agent 可读记录：`workspace/agents/<agentId>/watchdog/records/YYYY-MM-DD.md`
- Agent 日报：`workspace/agents/<agentId>/watchdog/reports/YYYY-MM-DD.md`
- 用户汇总日志：`workspace/logs/watchdog/YYYY-MM-DD.md`

## 记录策略

- 对 `node_modules` 批量变化，按依赖安装或更新做简要概括。
- 对 Git 分支切换、分支创建删除、提交引用更新，只记录分支与提交摘要。
- 对构建产物、缓存目录等常规批量变化，只记录为生成文件更新。

## Agent 提示词

可直接参考 `workspace/plugins/file-watchdog/agent-prompt.md` 中的模板，把 watchdog 纳入 Agent 的日常工作流程。