# pi-external-agent

[English](README.md) | 中文

[pi](https://github.com/earendil-works/pi) 扩展：把编码任务派发给本机安装的其他 agent CLI，并在运行中引导它们。

## 安装

```bash
# 锁定版本（推荐，pi update 不会动它）
pi install git:github.com/tom-cat-mao/pi-external-agent@v0.2.0

# 或跟随 main 分支
pi install git:github.com/tom-cat-mao/pi-external-agent
```

要求 pi ≥ 0.85，以及按需安装的各 agent CLI（不需要全部装齐）。

## 工具

| 工具 | 作用 |
|---|---|
| `external_agent_start` | 后台派发任务，立即返回 taskId |
| `external_agent_status` | 查看进度、最近事件和完整回答 |
| `external_agent_wait` | 在轮内阻塞等待任务完成 |
| `external_agent_stop` | 终止任务（协议取消，再 SIGTERM/SIGKILL） |
| `external_agent_steer` | 向运行中的任务注入引导（下一个 step 边界生效） |
| `external_agent_follow_up` | 任务结束后在同一会话续问，保留完整上下文 |

## Agent

| Agent | 厂商 | 默认模式 | 定位 | steer / follow-up |
|---|---|---|---|---|
| `codex` | OpenAI | yolo | 主力执行 | ✅ `app-server` |
| `pi` | pi 子进程 | yolo | `--model` 完全可配的执行体 | ✅ `--mode rpc` |
| `reasonix` | DeepSeek 原生 | yolo（deny 规则和 OS 沙箱仍生效） | 执行 / 评审 | ✅ ACP vendor 扩展 |
| `codebuddy` | 腾讯 | yolo | 快速执行 / 仓库探索 | ✅ ACP step 边界注入 |
| `kimi` | Moonshot | 仅 yolo（headless 拒收权限旗标） | 执行 | ❌ |
| `claude` | Anthropic | readonly | 分析 / 规划 | ❌ |

## 行为

- **权限模式**：`readonly` / `write` / `yolo`，映射到各 CLI 真实的沙箱或审批旗标，不是 prompt 层面的请求。同一目录的并发 write/yolo 任务会被拒绝。
- **无硬超时**：任务跑到结束为止。静默超过 watchdog（默认 15 分钟）会通知宿主模型，由它决定是否停止。需要立刻拿结果时用 `external_agent_wait`。
- **持久会话**：支持 steer 的 agent 以 turn 结束为完成信号而非进程退出，进程保活 30 分钟，这是 follow-up 能保留上下文的原因。
- **回执透明**：每次派发返回完整回执，记录实际 argv、生效权限策略、model/effort 是否真实转发——无法转发的会如实标注，不会静默丢弃。

各 CLI 的兼容性结论（flag、输出格式、坑）写在 `adapters.ts` 注释里。

## 文件

```
index.ts       工具注册、任务注册表、watchdog、通知
adapters.ts    各 CLI 一次性适配器
sessions.ts    持久会话驱动（steer / follow-up）
```

## 协议

MIT
