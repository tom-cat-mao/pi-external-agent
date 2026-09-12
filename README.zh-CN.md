# pi-external-agent

[English](README.md) | 中文

[pi](https://github.com/earendil-works/pi) 扩展：把编码任务派发给本机安装的其他 agent CLI，任务结束后可在同一会话续问，运行中也可引导（仅部分 agent）。

## 安装

```bash
# 锁定版本（推荐，pi update 不会动它）
pi install git:github.com/tom-cat-mao/pi-external-agent@v0.2.0

# 或跟随 main 分支
pi install git:github.com/tom-cat-mao/pi-external-agent
```

要求 pi ≥ 0.85，以及按需安装的各 agent CLI（不需要全部装齐）。

使用 qoder agent 需要安装 Qoder CLI（`qodercli`）并确保它在 `PATH` 上且已登录（`qodercli login`）。本集成针对 qodercli 1.0.18 测试；官方链接：[Run in Scripts](https://docs.qoder.com/cli/run-in-scripts)、[Permissions](https://docs.qoder.com/cli/permissions)、[ACP](https://docs.qoder.com/cli/acp)、[Settings reference](https://docs.qoder.com/cli/settings-reference)。

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
| `qoder` | 阿里 | yolo | 执行 / 独立评审 | follow-up ✅ `--acp`；steer ❌（未验证可引导当前轮） |
| `kimi` | Moonshot | 仅 yolo（headless 拒收权限旗标） | 执行 | ❌ |
| `claude` | Anthropic | readonly | 分析 / 规划 | ❌ |

## 行为

- **权限模式**：`readonly` / `write` / `yolo`，映射到各 CLI 真实的沙箱或审批旗标，不是 prompt 层面的请求。对没有 OS 沙箱的 CLI，`write`/`yolo` 只是权限规则层级，不是 OS 沙箱。同一目录的并发 write/yolo 任务会被拒绝。

- **无硬超时**：任务跑到结束为止。静默超过 watchdog（默认 15 分钟）会通知宿主模型，由它决定是否停止。需要立刻拿结果时用 `external_agent_wait`。

- **持久会话意味着可以 follow-up**：有会话通道的 agent 以 turn 结束为完成信号而非进程退出，进程保活 30 分钟，这是 `external_agent_follow_up` 能在保留完整上下文的前提下继续提问的原因。运行中 steer 是另一项独立能力：`codex`、`pi`、`reasonix`、`codebuddy` 额外支持，`qoder` 仅支持 follow-up。

- **回执透明**：每次派发返回完整回执，记录实际 argv、生效权限策略、model/effort 是否真实转发——无法转发的会如实标注，不会静默丢弃。

- **effort 需显式指定**：除非用户明确要求覆盖 reasoning effort／思考档位，否则省略 `effort`，沿用目标 CLI/config 默认值；不得根据任务复杂度自行选档。显式指定的值会按适配器允许范围校验，最终支持情况取决于所选模型与 CLI。`off` 是显式覆盖，不等同于省略。

- **codebuddy readonly 的实现**：不用 plan 模式，而是 `default` 权限模式 + 动态生成的 `--settings`——工具 allow/deny 规则，外加一个 `PreToolUse` Bash hook（`hooks/codebuddy-readonly.js`），启发式放行常见只读命令，拒绝编辑、写入、重定向、命令替换和已知会改状态的命令。hook 是启发式的 shell 过滤器，**不是** OS 级沙箱：它不得不放行的通用脚本入口（`node`、`npm`、`gh` 等）可以越过它的模式匹配，因此 readonly 是尽力而为，不是绝对保证。claude 的 readonly 仍走 plan 模式。

- **qoder readonly 的实现**：`--permission-mode dont_ask`（headless 下需要确认的操作一律拒绝）+ 内置工具白名单 `--tools Read,Grep,Glob,WebSearch,WebFetch`、`--disallowed-tools mcp__*,Agent`，并用 `--strict-mcp-config` 传入空 MCP 列表，另加每次调用专用的 `--settings {"disableAllHooks":true}` 关闭 user/project/local/plugin 全部 hook，使 hook 无法短路权限流程。因此编辑、Bash、MCP 工具和子 agent 启动都会被 Qoder 自身拒绝。已在 qodercli 1.0.18 实测：readonly 运行拒绝创建 fixture 文件。

- **qoder 的 write / yolo**：`write` 映射到 `--permission-mode accept_edits`（目录内编辑自动放行；ACP 权限请求一律回以 reject，没有 reject 选项时回 cancelled，绝不自动 allow），`yolo` 映射到 `bypass_permissions`。两者都继承 Qoder 自身配置的权限规则与 hook，**不是** OS 沙箱。非默认模式仅在受信任的启动目录生效，否则回落到 `default`（headless 下需要确认的操作同样被拒绝）。已在 qodercli 1.0.18 实测：`accept_edits` 成功创建 fixture 文件。

各 CLI 的兼容性结论写在 `adapters.ts` 注释以及每次派发回执的 `effective policy` 一行里。

## 文件

```
index.ts       工具注册、任务注册表、watchdog、通知
adapters.ts    各 CLI 一次性适配器
sessions.ts    持久会话驱动（steer / follow-up）
hooks/         codebuddy readonly --settings 使用的 PreToolUse Bash hook
```

## 协议

MIT
