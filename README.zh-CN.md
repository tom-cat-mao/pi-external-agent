# pi-external-agent

[English](README.md) | 中文

[pi](https://github.com/earendil-works/pi) 扩展：把编码任务派发给本机安装的其他 agent CLI，任务结束后可在同一会话续问，运行中也可引导（仅部分 agent）。

## 安装

```bash
# 锁定版本（推荐，pi update 不会动它）
pi install git:github.com/tom-cat-mao/pi-external-agent@v0.6.1
# 或跟随 main 分支
pi install git:github.com/tom-cat-mao/pi-external-agent
```

要求 pi ≥ 0.85，以及按需安装的各 agent CLI（不需要全部装齐）。Qoder 需要 `qodercli` 在 `PATH` 上并已登录；steer 还要求 CLI 声明的稳定版本 ≥ 1.1.49（见 [docs/qoder.md](docs/qoder.md)）。

## 工具

| 工具 | 作用 |
|---|---|
| `external_agent_start` | 后台派发任务，立即返回 taskId |
| `external_agent_status` | 查看进度、最近事件和完整回答 |
| `external_agent_wait` | 在轮内阻塞等待任务完成 |
| `external_agent_compare` | 一次阻塞调用把同一任务发给多个 agent，并排收集答案 |
| `external_agent_stop` | 终止任务（协议取消，再 SIGTERM/SIGKILL） |
| `external_agent_steer` | 向运行中的任务注入引导（下一个 step 边界生效） |
| `external_agent_follow_up` | 任务结束后在同一会话续问，保留完整上下文 |

## 多 agent 对比

`external_agent_compare` 一次调用把同一个任务交给多个 agent，并排返回答案；它从不对比、打分或排序——agent 之间的分歧正是这个工具要暴露的信号。每个 spec 走与 `external_agent_start` 相同的派发路径和校验（被拒绝的 spec 带着原因记入回执，其余照常运行），超时回执返回已结束的部分以及仍在运行的 taskId。

| 参数 | 说明 |
|---|---|
| `task` | 发给每个 agent 的指令（必填；与 `external_agent_start` 一样需自包含） |
| `agents` | 2–8 个 spec：`{ agent, task?, cwd?, mode?, model?, effort? }`；spec 的 `task` 可覆盖共用任务。`mode` 默认取该 agent 自身默认值，`cwd` 默认会话目录 |
| `timeout` | 整批的等待秒数（可选；默认 600，上限 3600） |

## 可选能力（opt-in）

默认全部关闭，传参即生效——`template`（输出契约）、`verify`（settle 后跑验收命令）、`isolate`（新建 git worktree）、`board`（JSONL 证据行，仅 compare）、`fromTaskId`（把已结束答案注入另一会话，仅 follow_up）、`offset`（分页召回归档答案，仅 status）、`/external_agent_stats`（CLI 自报用量计数）。长答案在 settle 时归档，内联只留句柄 + 摘要，不再全文重放。详见 [docs/capabilities.md](docs/capabilities.md)。

## Agent

| Agent | 厂商 | 默认模式 | steer / follow-up |
|---|---|---|---|
| `codex` | OpenAI | yolo | ✅ `app-server` |
| `pi` | pi 子进程 | yolo | ✅ `--mode rpc` |
| `reasonix` | DeepSeek 原生 | yolo（deny 规则和 OS 沙箱仍生效） | ✅ ACP vendor 扩展 |
| `codebuddy` | 腾讯 | yolo | ✅ ACP step 边界注入 |
| `qoder` | 阿里 | yolo | follow-up ✅；steer ✅，需 CLI 声明的版本满足 1.1.49 基线 |
| `kimi` | Moonshot | 仅 yolo（headless 拒收权限旗标） | ❌ |
| `claude` | Anthropic | yolo（readonly–yolo 三档；effort low–max，无 off） | ✅ stream-json |

## 文档

- [AGENTS.md](AGENTS.md) — 目录结构、命令、不变式、文档规则
- [docs/architecture.md](docs/architecture.md) — 派发流程、回执、传输层 · [docs/adapters.md](docs/adapters.md) — 各 CLI 能力矩阵
- [docs/capabilities.md](docs/capabilities.md) — 归档、验收、模板、relay、隔离、证据板、计量 · [docs/qoder.md](docs/qoder.md) — Qoder stream-json 契约 · [.agents/notes/](.agents/notes/) — 决策记录

## 社区

[LINUX DO](https://linux.do/)

## 许可证

MIT
