# Grok Build 核心架构学习笔记

> 本文档是对 `grok-build` 代码库的架构探索记录，用于日后对照源码学习。
> 所有结论均来自直接阅读源码，关键处附 `文件:行号` 引用，可点击跳转。
> 仓库是从 SpaceXAI monorepo 周期性同步出来的子集（根目录 `SOURCE_REV` 记录对应 commit）。

## 目录

1. [一句话总览](#1-一句话总览)
2. [分层全景图](#2-分层全景图)
3. [组合根：xai-grok-pager-bin](#3-组合根xai-grok-pager-bin)
4. [三种运行模式](#4-三种运行模式)
5. [核心边界：ACP（Agent Client Protocol）](#5-核心边界acpagent-client-protocol)
6. [Leader 架构](#6-leader-架构)
7. [Agent 运行时：xai-grok-shell](#7-agent-运行时xai-grok-shell)
8. [两层 actor 循环 + ReAct turn](#8-两层-actor-循环--react-turn)
9. [流式采样：xai-grok-sampler](#9-流式采样xai-grok-sampler)
10. [会话状态：xai-chat-state](#10-会话状态xai-chat-state)
11. [工具系统：xai-tool-runtime + xai-grok-tools](#11-工具系统xai-tool-runtime--xai-grok-tools)
12. [Workspace 服务：xai-grok-workspace](#12-workspace-服务xai-grok-workspace)
13. [沙箱：xai-grok-sandbox](#13-沙箱xai-grok-sandbox)
14. [MCP 集成：xai-grok-mcp](#14-mcp-集成xai-grok-mcp)
15. [配置：xai-grok-config](#15-配置xai-grok-config)
16. [鉴权：xai-grok-auth](#16-鉴权xai-grok-auth)
17. [内存：xai-grok-memory](#17-内存xai-grok-memory)
18. [密钥脱敏：xai-grok-secrets](#18-密钥脱敏xai-grok-secrets)
19. [Hooks：xai-grok-hooks](#19-hooksxai-grok-hooks)
20. [插件市场：xai-grok-plugin-marketplace](#20-插件市场xai-grok-plugin-marketplace)
21. [工作流：xai-workflow](#21-工作流xai-workflow)
22. [遥测：xai-grok-telemetry](#22-遥测xai-grok-telemetry)
23. [模型：xai-grok-models](#23-模型xai-grok-models)
24. [一次 turn 的完整数据流](#24-一次-turn-的完整数据流)
25. [关键设计决策](#25-关键设计决策)
26. [Crate 索引](#26-crate-索引)
27. [关键文件速查表](#27-关键文件速查表)

---

## 1. 一句话总览

Grok Build 是 SpaceXAI 的终端 AI 编码代理（对标 Claude Code / Codex CLI）。主线：
**TUI/UI 层 →（ACP 协议）→ Agent 运行时 →（工具调用）→ 工具实现 + Workspace 服务**，
外围环绕配置、鉴权、内存、hooks、遥测等子系统。用 Rust 写成，~70 个 crate 的工作区。

## 2. 分层全景图

```
┌─────────────────────────────────────────────────────────────┐
│  xai-grok-pager-bin  (组合根 main.rs：解析 CLI、装配、分发)    │
└───────────────┬─────────────────────────────────────────────┘
                │ 三种运行模式
      ┌─────────┼──────────────────┐
      ▼         ▼                  ▼
 交互式 TUI   headless 单轮     `grok agent ...`
 (pager)    (run_single_turn)   stdio / headless / serve / leader
      │         │                  │
      ▼         ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│        ACP 边界 (Agent Client Protocol, JSON-RPC over stdio)  │  ← xai-acp-lib
│   leader 模式下: 通过 IPC 连到常驻 leader 进程;否则 in-process  │
└───────────────┬─────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent 运行时  (xai-grok-shell)                              │
│   MvpAgent = turn 循环: prompt->流式模型响应->工具调用->执行->回环  │
│   session / compaction / sampling / prompt-queue / subagent  │
└───────┬───────────────────────────────┬─────────────────────┘
        ▼                               ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ 工具层 (xai-tool-     │   │ Workspace 服务 (xai-grok-workspace)│
│  runtime + tools)     │   │  独立进程: FS / VCS / exec /      │
│  Tool trait(流式) +   │   │  权限 / 检查点 / worktree / sandbox│
│  bash/read/edit/      │   │  ← client 经 workspace.* RPC 调用 │
│  grep/search/web/...  │   └──────────────────────────────────┘
│  + MCP / LSP / skills │
└──────────────────────┘
        │ 外围子系统
        ▼
 config(分层TOML+签名托管) · auth(OAuth/部署密钥) · memory(MD+SQLite) ·
 hooks/plugins · workflow(Rhai编排) · telemetry(多sink) · secrets(脱敏)
```

## 3. 组合根：xai-grok-pager-bin

这个 crate 故意做得很薄（只有一个 `src/main.rs`，3149 行），作用是**打破依赖环**并把"最小渲染模式"在启动时注入（`xai_grok_pager_minimal::install()` —— 一个函数指针 IoC 接缝，`xai-grok-pager-minimal/src/lib.rs:116`）。

`main()` → `async_main()` 关键流程（`xai-grok-pager-bin/src/main.rs:1639` / `:1717`）：

1. mermaid 子进程 fork-check（`maybe_run_render_subprocess`）
2. 解析 CLI（clap 结构定义在 pager 库的 `xai-grok-pager/src/app/cli.rs`，不在二进制里）
3. `--version` / `doctor` 在 tokio runtime 建好**之前**就处理掉
4. `xai_grok_pager_minimal::install()` 注入最小渲染模式
5. 装 jemalloc / 内存追踪、提 FD 上限、校验托管策略版本（`xai_grok_config::validate_requirements`）、装 crash handler
6. 建 tokio runtime，按 `args.command` 分发（见下节）

产物名 `xai-grok-pager`，官方发布改名 `grok`。`build.rs` 用 `git rev-parse` + `GROK_VERSION` 生成 `VERSION_WITH_COMMIT` 编译期变量。

## 4. 三种运行模式

`async_main` 里的命令 `match`（`main.rs:1784-1968`）：

| 模式 | 触发 | 入口 |
|---|---|---|
| **工具子命令** | `login/logout/update/mcp/plugin/models/sessions/worktree/workspace/leader/inspect/setup/export/trace/memory/completions/wrap/dashboard` | 各自叶子处理 |
| **headless 单轮** | `grok -p "..."` / `--prompt-json` / `--prompt-file` | `xai_grok_pager::headless::run_single_turn`（`xai-grok-pager/src/headless.rs:821`） |
| **交互 TUI**（默认） | 无子命令且无 prompt 标志 | `xai_grok_pager::app::run`（`xai-grok-pager/src/app/mod.rs:442`） |
| **`grok agent`** | `Command::Agent` | `run_agent_command`（`main.rs:993`），再分：`stdio`(ACP) / `headless`(grok.com relay) / `serve`(WS server) / `leader`(常驻进程) |

agent 四入口在 `xai-grok-shell/src/agent/app.rs`：
- `run_stdio_agent` `:300` — ACP JSON-RPC over stdio（IDE 桥接）
- `run_headless` `:420` — agent over grok.com WebSocket relay
- `run_agent_server` `server.rs:458` — agent 作为 WebSocket server
- `run_leader` `app.rs:928` — 作为共享 leader 进程

## 5. 核心边界：ACP（Agent Client Protocol）

ACP 是**整个系统的中枢契约**——UI 与 agent 运行时之间、IDE 与 agent 之间都走 ACP（基于 `agent-client-protocol` crate 的 JSON-RPC）。`xai-acp-lib` 做了类型化封装（`src/message.rs`）：

- `AcpSide` trait（`message.rs:16`）：标记连接的一端（AgentSide / ClientSide）
- `AcpMethod` / `AcpRequest`（`:44` / `:49`）：把请求/响应对连起来，`method_name()` 返回 RPC 方法名
- `AcpArgsGeneric<T, S>`（`:54`）：一个请求 + 一个 oneshot 响应通道

关键方法：`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、`models/*`，外加 `x.ai/*` 扩展方法（hooks/plugins/marketplace）。

传输层：`channel.rs`（AcpChannel）、`gateway.rs`（网关收发）、`stdin_reader.rs`（`spawn_stdin_line_reader` —— 专用 OS 线程做阻塞 stdin 读，因为 Windows 上 tokio stdin 对常驻管道只在 EOF 才交付）。

## 6. Leader 架构

**单机单 leader** 设计（`xai-grok-shell/src/leader/mod.rs`）：

- 一个 **leader 进程**独占 `MvpAgent` 和全部会话状态，持久化到 `~/.grok/`
- 多个**客户端**（TUI / IDE 扩展 / headless CLI）通过 Unix domain socket（`~/.grok/leader.sock`）连它
- `connect_or_spawn()`（`leader/mod.rs:1205`）：有 leader 就连；没有（或现有 leader 版本更旧 —— `should_evict` `:104`）就抢 `LeaderLock` 起子进程。**新版本客户端驱逐旧 leader，反之不成立**（防抖）
- `ClientMode`（`leader/protocol.rs:110`）：
  - `Stdio` — TUI/IDE/`grok -p`，客户端直接经本地 socket 传 ACP
  - `Headless` — `grok agent`，走 grok.com websocket relay，leader 转发
- `run_leader_server()`（`leader/server.rs:1505`）：IPC 路由循环，跟踪 `session_driver`（驱动某会话的客户端）和 `session_subscribers`（旁观客户端），按客户端注入能力（yolo/auto/model/terminal/fs）

**Leader-bridge 模式**（`main.rs:1141-1308`）：`run_agent_command` 调 `resolve_use_leader`（`app/mod.rs:372`）决定 in-process 还是委托 leader。若用 leader，则起 stdin-bridge / stdout-bridge 任务转发 ACP，leader 断线时 `LeaderReconnector` 重连 + **重放缓存的 ACP 会话状态**（replay 状态机 `main.rs:619-941`：跟踪多会话、从捕获的 `session/new` 合成 `session/load`、阻塞等到每个 load 响应到达）。

Leader 自带 1 小时周期自动更新（`run_auto_update_checker`，`agent/app.rs:103`）：idle 时 flush 所有 session actor 再优雅退出，让新二进制经 `connect_or_spawn` 接管。

leader 模式判定优先级（`app/mod.rs:379-395`）：`--no-leader` > `--leader` > 不符合条件 > config `[cli] use_leader` > remote `leader_mode` > 默认 off。

## 7. Agent 运行时：xai-grok-shell

核心是 `MvpAgent`（`agent/mvp_agent/mod.rs:597`，2600+ 行），它实现 ACP `Agent` trait（`mvp_agent/acp_agent.rs`）：`new_session`(`:844`) / `load_session`(`:1231`) / `prompt`(`:2006`)。`prompt` 查 `SessionHandle` 并发 `SessionCommand::Prompt` 到该会话的命令通道。

**每个会话 = 独占一个 OS 线程的 actor**（`session/acp_session_impl/spawn.rs:2125`）：
```rust
let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()...;
let local = tokio::task::LocalSet::new();
local.block_on(&rt, async move { spawn_session_actor(...).await });
```
所以 `SessionActor`（`session/acp_session.rs:579`）大量用 `RefCell`/`Rc`/`Cell`（`!Send`），钉在一个线程上。`MvpAgent` 在 leader 线程持有 `sessions: RefCell<HashMap<SessionId, SessionHandle>>`，每个 `SessionHandle` 拥有一条 `mpsc::UnboundedSender<SessionCommand>` 通向自己的 session actor。

`xai-grok-shell/src/lib.rs` 是模块枢纽：`agent` / `auth` / `leader` / `session` / `sampling` / `tools` / `config` / `relay` / `remote` / `terminal` 等。

## 8. 两层 actor 循环 + ReAct turn

### 外层：`run_session`（`session/acp_session_impl/run_loop.rs:116`）

`tokio::select!` 多路复用：
- `cmd_rx` — `SessionCommand`（Prompt / SessionMode / SetSessionModel / InjectNotification / 队列编辑等）。`SessionCommand::Prompt`(`:382`) → `queue_input` → `maybe_start_running_task`
- `completion_rx` — `(prompt_id, PromptTurnResult)` turn 完成回调（`:309`）。完成后 `handle_completion` → `handle_turn_end` → `maybe_start_running_task` —— **这是把下一个排队 prompt 提升起来的回环点**
- `chat_state_event_rx` — `ChatStateEvent`（ConversationReset / ImageBudget / TokensUpdated）
- `event_rx` — `SessionEvent`（通知、replay flush）
- 定时器：idle 内存 flush、dream 检查、模型切换 watch

`maybe_start_running_task()`（`acp_session_impl/notification_drain.rs:115`）是准入闸：无 `running_task` 且 `pending_inputs` 非空时弹出队首、设 `running_task`、起 `spawn_local` 跑 `process_conversation_turn` 并把结果发到 `completion_tx`。

### 内层：`process_conversation_turn`（`session/acp_session_impl/turn.rs:1798`）

这就是 ReAct 循环 `loop { ... }`（`:1904`）：

1. **预采样收尾**（`:1905-1938`）：emit `LoopStarted`、排空 pending interjections（Ctrl+Enter 中途插话）、flush skill reminders、注入 monitor 事件、首轮 memory reminder、MCP reminder、`check_auto_compact_needed()` → `run_compact_only()`
2. **构建工具**（`:1942-1958`）：`turn_base_tool_specs`，外加可选 `StructuredOutput` 工具（`--json-schema`）
3. **构建请求**（`:1960-1978`）：`chat_state_handle.build_request(effective_tools, memory_reminder, ...)` 组装 `ConversationRequest`
4. **发 LLM**（`:2026`）：`self.run_turn_via_sampler(request)`
5. **处理 sampler 结果**（`:2026-2074`）：
   - `SamplerTurnOutcome::Response(r, latency)` → 进工具处理
   - `SamplerTurnOutcome::CompactAndResubmit` → `continue`（从压缩后状态重建）
   - `SamplerTurnOutcome::RefreshAuthAndResubmit` → 退避（1s/2s/4s，`AuthRetrySchedule` `:2440`）后 `continue`
6. **处理响应**（`:2169-2226`）：提取 `tool_calls`、记录 assistant 响应 / push tool 结果到 chat state、emit fallback 文本/refusal
7. **决定回环**（`:2227-2422`）：
   - `tool_calls.is_empty()` → 最终回答。跑 **TodoGate**（`:2230-2245`）：有待办 todo 就注入 nudge 强制再来一轮；否则 `TurnOutcome::Completed`
   - 有 tool 调用 → `execute_tool_calls`（`:2375`）→ 处理 `ToolLoop`（PermissionReject/Cancelled/FollowupMessage/HookDenied）→ 检查 `max_turns`（`:2404`）→ preflight 溢出压缩 → **`continue`** 回到循环顶

### 工具执行：`execute_tool_calls`（`acp_session_impl/tool_calls.rs:284`）

每个 tool call：
1. `prepare_tool_call`(`:337`) — 权限检查、hook 分发、参数解析。返回 `PreparedToolCall` 或 `ToolLoop` 错误
2. 同文件写工具经 per-path `tokio::Mutex` 串行化（`lock_path_for_args`，`tool_dispatch.rs:56`）
3. `dispatch_tool`（`tool_dispatch.rs:13`）→ `workspace_ops.call_tool(name, args, call_id, session_id)` —— 所有工具执行都过 `WorkspaceOps` / `ToolBridge`（`xai-grok-tools`），它持有 `ToolRegistry`

### 关键类型

- `TurnOutcome`（`acp_session_impl/types.rs:44`）：`Completed` / `Cancelled` / `MaxTurnsReached`
- `SamplerTurnOutcome`（`types.rs:32`）：`Response` / `CompactAndResubmit` / `RefreshAuthAndResubmit`
- `ToolLoop`（`types.rs:69`）：`Continue` / `PermissionReject` / `Cancelled` / `FollowupMessage` / `HookDenied`
- `PromptOrigin`（`session/mod.rs:58`）：区分用户 prompt vs 合成自动唤醒（TaskCompleted / SubagentCompleted / NotificationDrain / GoalSummary / SchedulerFired / PlanResume）

## 9. 流式采样：xai-grok-sampler

`SamplerHandle`（`xai-grok-sampler/src/handle.rs:19`）是指向 `SamplerActor`（独立 task 的 actor）的廉价克隆句柄。session spawn 时（`spawn.rs:1081`）：
```rust
let (sampler_event_tx, sampler_event_rx) = mpsc::unbounded_channel::<SamplingEvent>();
let sampler_handle = xai_grok_sampler::SamplerActor::spawn(sampler_config, retry_policy, sampler_event_tx);
```
一个 `spawn_local` drainer（`spawn.rs:1618`）读 `sampler_event_rx` 调 `session.handle_sampling_event(event)`。

`handle_sampling_event`（`acp_session_impl/tool_calls.rs:2377`）把 `SamplingEvent` 翻译成 ACP `SessionUpdate` 通知发客户端：
- `ChannelToken { channel: Text, text }` → `AgentMessageChunk`（`:2424`）
- `ChannelToken { channel: Reasoning, text }` → `send_thought_chunk`（`:2449`）
- `ToolCallDelta` → `ToolCallDeltaChunk`（`:2465`）

`submit_and_collect`（`handle.rs:113`）await 一个 oneshot 拿最终 `ConversationResponse` + `InferenceLatencyStats`，同时流式事件实时推 UI。`CancelOnDrop`（`:121`）保证 future 被 drop 时取消在途请求。

**SamplerConfig**（`xai-grok-sampler/src/config.rs:49`）：`api_key`/`base_url`/`model`、`temperature`/`top_p`/`max_completion_tokens`、`api_backend`（Responses vs Chat Completions 协议形状）、`auth_scheme`、`context_window`、`stream_tool_calls`、`reasoning_effort`、`extra_headers`、`compactions_remaining`/`compaction_at_tokens`（服务端压缩头）、`doom_loop_recovery`（发 `x-grok-doom-loop-check` 头）、以及不可序列化的动态回调（`attribution_callback`/`bearer_resolver`/`header_injector`）。

`SamplingEvent`（`events.rs:28`）：`StreamStarted` / `FirstToken` / `ChannelToken` / `ToolCallDelta` / `Completed` / `Retrying` / `Failed` / `ModelMetadata`。`SamplingChannel`（`:18`）= `Text` | `Reasoning`。

模型选择优先级（`xai-grok-models/src/lib.rs:4`）：`CLI flag > ENV > config.toml > remote settings > 内置 default`。`MvpAgent::resolve_model_id` / `prepare_sampling_config_for_model`（`agent_ops.rs:1117`/`1144`）。

## 10. 会话状态：xai-chat-state

**actor 化**的状态管理（`xai-chat-state/src/lib.rs`）：`ChatStateActor` 跑在独立 tokio task，单线程无锁持有：
- `conversation: Vec<ConversationItem>`
- `sampling_config: SamplingConfig`
- `prompt_index: usize`
- `total_tokens: u64`

`ChatStateHandle` 是 `SessionActor` 用的克隆句柄。关键方法：`build_request`（`handle.rs:334`，组装 `ConversationRequest`）、`push_user_message`/`push_assistant_response`/`push_tool_result`、`record_*_usage`（token 账本 `UsageLedger`）、`replace_conversation_for_compaction`/`record_compaction_at`、`update_credentials`/`get_credentials`。

`ChatStateEvent`（回给 session actor）：`ConversationReset` / `ImageBudget`（内联图片超阈值时驱逐以回收上下文）/ `PromptIndexChanged` / `TokensUpdated`。

`ConversationItem`（`xai-grok-sampling-types/src/conversation.rs:28`）：User / Assistant / ToolResult 等。`ConversationRequest`（`:528`）带 `items`、`tools`（客户端 `ToolSpec`）、`hosted_tools`（服务端）、`tool_choice`、`model`、`temperature`、`top_p`、`max_output_tokens`、`reasoning_effort`、`json_schema`、`prompt_cache_key`、`x_grok_*` 追踪头。

## 11. 工具系统：xai-tool-runtime + xai-grok-tools

### 统一 `Tool` trait（`xai-tool-runtime/src/tool.rs:36`）

```rust
pub trait Tool: Send + Sync {
    type Args: for<'de> Deserialize<'de> + JsonSchema + Send + 'static;
    type Output: Serialize + ToolOutput + Send + 'static;
    fn id(&self) -> ToolId;
    fn description(&self, _ctx: &ListToolsContext) -> ToolDescription;
    fn capabilities(&self) -> ToolCapabilities { ToolCapabilities::default() }
    fn has_dynamic_description(&self) -> bool { false }
    fn should_list(&self, _ctx: &ListToolsContext) -> bool { true }
    fn execute(&self, ctx, args) -> impl Future<Output = ToolStream<Self::Output>> + Send { ... } // 流式入口，默认包 run
    fn run(&self, _ctx, _args) -> impl Future<Output = Result<Self::Output, ToolError>> + Send { ... } // 阻塞便捷钩子，默认 NotImplemented
}
```

设计要点：
- 用**原生 `async fn` in trait（RPITIT）+ 显式 `Send` bound**，不是 `#[async_trait]`，future 不装箱。trait 只被泛型消费，类型擦除走 `ToolDyn`
- `execute` 是规范入口；默认把 `run` 包成单项流。两者都不实现 → `ToolError::not_implemented`

### 流式原语

- `ToolStream<T> = Pin<Box<dyn Stream<Item = ToolStreamItem<T>> + Send>>`（`:116`）
- `ToolStreamItem<T>`（`:120`）：`Progress(ToolProgress)*` 后跟恰好一个 `Terminal(Result<T, ToolError>)`
- `ToolProgress`（`:139`）：`Text` / `Content{blocks}` / `Custom{subkind, payload}`
- `ContentBlock`（`:166`）：`Text` / `Image`(base64 + 可选 media_id/filename/path) / `Resource`
- 构造器：`terminal_only()`（`:206`）/ `with_progress()`（`:218`）

### 结果回传 LLM

`TypedToolOutput`（`:246`）：`{ tool_id, value(JSON), model_output: Vec<ContentBlock>(恒非空，MCP 合规), chat_completion_output }`。blanket impl（`:358`）把 `T::Output` 序列化成 `value`，调 `ToolOutput::model_output()`；为空则 fallback 到 `extract_content_blocks(&value)`。这些 `model_output` blocks 就是 LLM 收到的工具结果。

### 类型擦除：`ToolDyn`（`:306`）

object-safe 接口，blanket `impl<T: Tool> ToolDyn for T`（`:337`）。`execute` 收 `Value`，反序列化成 `T::Args`，调 `Tool::execute`，把每个 terminal 映射成 `TypedToolOutput`。`ArcTool = Arc<dyn ToolDyn>`（`:405`）。

`ToolDispatch`（`dispatch.rs:32`）：object-safe 路由器，`call` / `call_terminal`（默认 drain 流）。

### 协议/wire 层：`xai-tool-protocol`

纯 wire 类型：JSON-RPC 2.0 信封、帧（`ToolCallParams`/`ToolCallResult`/`ToolCallProgressFrame`/`ToolCallNotificationFrame`）、握手（`HelloMsg`/`HelloAckMsg` + `PROTOCOL_VERSION`）、**注册**（`registration.rs`：`ToolRegistration` 单工具 / `ToolServerRegistration` 批量 / `RegistrationOutcome` Registered/Updated/Shadowed/Rejected）。

### 工具家族

`ToolFamily` + `ToolVariant`（`tool.rs:419`）：一个 `ToolId` 下多实现按 variant 路由。

### 具体工具（`xai-grok-tools/src/implementations/mod.rs`）

按命名空间分组（`types/tool.rs:33`，`ToolNamespace`）：`GrokBuild` / `GrokBuildConcise` / `GrokBuildHashline` / `Codex` / `OpenCode` / `MCP`。codex 和 opencode 是显式 in-tree 源码移植（见 `THIRD-PARTY-NOTICES`）。

注册点在 `registry/types.rs:663-747`（`ToolRegistryBuilder::new` 里的 `register::<T>()` 调用）。

**GrokBuild** 原生工具：`run_terminal_cmd`(Bash)、`read_file`、`search_replace`、`list_dir`、`grep`、`kill_task`/`get_terminal_command_output`/`wait_tasks`、`task`(子代理)、`todo_write`、`update_goal`、`workflow`、`web_search`、`web_fetch`、`lsp`、`image_gen`/`image_edit`/`image_to_video`/`reference_to_video`、`enter_plan_mode`/`exit_plan_mode`、`ask_user_question`、`monitor`、`scheduler_create/delete/list`、`deploy_app`(stub)。

**GrokBuildHashline**：`hashline_read`/`hashline_edit`/`hashline_grep`（锚点行哈希编辑）。
**Codex**：`apply_patch`(V4A patch)、`list_dir`/`grep_files`/`read_file`。
**OpenCode**：`bash`/`edit`/`write`/`read`/`grep`/`glob`/`todowrite`/`skill`。

`ToolKind`（`types/tool.rs:70`）有 31 个变体（Read/Edit/Delete/Write/Move/ListDir/Search/Lsp/Execute/Plan/WebSearch/Task/Workflow/MemorySearch/...），用于权限和遥测分类。`is_read_only()`（`tool_taxonomy.rs:79`）分类。

### 注册机制

`ToolRegistryBuilder`（`registry/types.rs:519`）持 `HashMap<String, ToolEntry>`。`register::<T>()`（`:536`）把具体类型捕获进 `ToolEntry`（含 `output_converter`、参数校验器、`register_in_local` 闭包）。`finalize()`（`:931`）校验配置、构建 `Resources`（terminal backend / FS / cwd / skills / memory / web / LSP）、起 scheduler actor、产出 `FinalizedToolset`（`:445`，持 `RwLock<Vec<FinalizedTool>>`）。`FinalizedToolset::call`/`call_streaming`（`:1446`）→ `prepare_dispatch`（`:1513`）→ `LocalRegistry.execute` → drain 流 → `finalize_output`（`:1592`，应用 converter、收 reminders、渲染 prompt 文本、持久化资源）。

## 12. Workspace 服务：xai-grok-workspace

**独立进程**，把所有"碰主机"的操作隔离：FS、git/jj VCS、shell 执行、权限裁决、检查点、worktree、sandbox。

### client/server/types 三 crate 拆分

- **`xai-grok-workspace-types`**（`workspace-types/src/lib.rs`）：纯数据 wire 类型（无 tokio/async）。`WorkspaceRpc` trait（METHOD const + Response 类型）、`RpcEnvelope`、请求/chunk/event 枚举，全部**相邻标签**（`{"type":"...","data":...}`）。可 codegen 到 protobuf，可被 WASM 依赖
- **`xai-grok-workspace-client`**（`workspace-client/src/lib.rs:133`）：`WorkspaceClient`，typed RPC client over `ToolHarness`。所有 `workspace.*` 方法（`git_status`/`fs_read_file`/`hunk_action`/`create_worktree`/`begin_prompt`/`rewind_to`...）都经一个 `workspace_rpc` hub 工具（`rpc_raw` `:184`），它调 `harness.call(tool_id, {method, params})` 并 drain 流
- **`xai-grok-workspace`**（`workspace/src/lib.rs`）：服务端：`WorkspaceHandle`（`handle.rs`）、`WorkspaceSession`（`session/mod.rs`）、`workspace_server` 二进制（`bin/workspace_server.rs`）、hub（`hub.rs`）、权限（`permission/`）

**`WorkspaceOps`**（`workspace_ops.rs:1`）是双模句柄：`Local`（扩展经 `WorkspaceHandle`、工具经 session 的 `FinalizedToolset`）/ `Proxy`（一切经 hub WebSocket 路由到远端 workspace server）。

**为什么拆分**：同一 typed RPC 接口（`WorkspaceRpc`）既能在进程内（Local）跑，也能经 WebSocket 对远端 workspace server（Proxy）跑。支持 headless/CI/沙箱场景（agent 进程和 workspace server 进程分离），并让 wire 类型可被轻量消费者（含未来 WASM 浏览器 SDK）依赖而不拉入 tokio/rmcp。

### 文件系统 trait

`AsyncFileSystem`（`file_system/fs.rs:16`）：`root`/`exists`/`read_file`/`try_read_file`/`write_file`/`delete_file`。后端：`LocalFs`/`AcpSessionFs`(编辑器会话)/`MockFs`/`AcpFsAdapter`，外加 `git_status`/`jj_status`、模糊文件匹配、ripgrep 内容搜索、文件索引。

### Shell 执行

执行**不在** workspace crate，而是注入的。`SessionContext`（`registry/types.rs:220`）带 `backend: Arc<dyn TerminalBackend>` + `fs: Arc<dyn AsyncFileSystem>`。bash 工具经 `TerminalBackend` 分派；本地实现是 `LocalTerminalBackend`（`xai-grok-tools/src/computer/local/terminal.rs`，含 `static_shell.rs`/`shell_state.rs`/`cgroup.rs` 进程分组）。后台任务经 `ProcessGroup`（`util/spawn.rs`）跟踪。

### VCS / git status

三层：
- **`xai-gix-status`**：用 `gix` 库做 git status，nproc 感知的线程预算（`compute_gix_status_thread_limit` `:40`），避免紧 `RLIMIT_NPROC` 下 `gix::in_parallel` 的 `expect("valid name")` abort
- **`xai-grok-workspace/src/file_system/git_status.rs`**：`git_status()`/`git_status_short()` 包装
- **`xai-hunk-tracker`**：actor 化 hunk(diff) 跟踪，**区分 Agent 写 vs 外部改动**归属。`HunkTrackerActor` 跑在独立 tokio task；`HunkTrackerHandle`（`handle.rs:17`）廉价克隆。命令：`record_agent_write`/`handle_file_change`/`refresh_git_dirty_cache`/`reset_baseline`；查询：`get_all_hunks`/`get_turn_hunks`/`hunk_action`(accept/reject)/`snapshot_state`/`restore_state`(fork 同步)/`snapshot_turn_delta`。模式：`AllDirty`/`AgentOnly`/off

### 检查点 / 回退（`session/checkpoint.rs`）

`RewindCheckpoint`（`:90`）：`{ prompt_index, fs: RewindPoint, hunks: Option<HunkTurnDelta> }`。三个域各由 env 开关 gate：
- **FS** — `file_state_tracker.begin_prompt(idx)`/`end_prompt()`（`:248`），捕获 touched 文件前后快照
- **Git** — `git::capture_git_state()` + `git_checkpoints.record(idx)`；恢复用 `soft_restore_git_state`（stash + `reset --soft` + unstage）。`GROK_WORKSPACE_REWIND_GIT`（默认 OFF）
- **Hunks** — `capture_hunk_delta(idx)`（`:115`）；恢复组合 `< target` 的存储 delta。`GROK_WORKSPACE_REWIND_HUNKS`（默认 OFF）

扇出入口 `WorkspaceHandle::on_turn_boundary`（`:238`，按 `prompt_index` 区分 turn hook vs rewind RPC）。用户发起恢复 `rewind_to`（`:372`）：先 git soft-restore，再 FS revert，再 re-stage + 截断 `>= target` 的检查点。持久化经 `CheckpointStore`（`session/checkpoint_store.rs`，`GROK_WORKSPACE_REWIND_DURABLE`）。

### 权限系统（`permission/`）

`manager.rs`/`policy.rs`/`rules.rs`/`exec_risk.rs`(bash 命令风险分级)/`shell_access.rs`/`prompter.rs`(交互审批)/`auto_mode.rs`(沙箱下自动批准)/`bash_command_splitting.rs`/`claude_settings.rs`(兼容 Claude settings)/`hub_permission.rs`。`PermissionDecision`/`PermissionRequest` 在 `workspace-types/src/types/permission.rs`。沙箱可自动放行 bash（`should_auto_allow_bash`）。

### Hub（`hub.rs`）

workspace 经 `ToolServer` + `WorkspaceToolHandler` 把会话工具暴露给远端 server；多会话经每 `(url, principal)` 一个 WebSocket 复用（`HubConnectionPool`）。`HubConfig`（`:58`）：WebSocket URL、auth provider、server ID。

## 13. 沙箱：xai-grok-sandbox

OS 级沙箱，基于 **`nono`** crate（Linux Landlock + macOS Seatbelt）。模型（`lib.rs:8`）：进程启动时**一次性施加，不可逆**；覆盖进程内 `tokio::fs` 调用和子进程；进程级网络放开（要调 LLM API），但**子进程网络按 seccomp 逐子进程阻断**。

`SandboxManager`（`lib.rs:128`）：`new(profile, workspace)` → `apply()`(不可降级，不支持时优雅退化) → `install()`(存全局 `GlobalSandboxState` 于 `OnceLock`，供会话期违规日志)。`enforce` feature（默认 on）拉入 `nono`。

**Profile**（`profiles.rs:60`）：`Workspace`(默认，读一切/写 essentials)/`Devbox`(除 `/data` 外皆可写)/`ReadOnly`(阻断网络)/`Strict`(系统路径 allowlist + 断网)/`Off`/`Custom(String)`。解析成 `SandboxProfile`(`:24`) → `nono::CapabilitySet`(`:200`)。

**配置**：`~/.grok/sandbox.toml`(全局) + `.grok/sandbox.toml`(项目，**仅加性** —— 项目不能重定义全局自定义 profile 名，防恶意仓库掏空受信 profile，`profiles.rs:155`)。

**Linux bwrap 重执行**（`lib.rs:249`）：Landlock 覆盖不到的挂载命名空间用 bwrap —— devbox `/data` 写拒绝用 `--ro-bind`，读拒绝用零权限占位符 bind-over。glob 拒绝在 Linux 是 best-effort（启动时展开一次），macOS Seatbelt 作运行时 regex 强制。

**网络策略**（`network_policy.rs`）：`ChildNetworkPolicy`/`WebsitePolicy`/`NetworkPolicySnapshot`，经 `child_net.rs` 装 per-child seccomp。`should_restrict_child_network()`(`lib.rs:72`) gate 已知 Linux 子进程启动路径。

## 14. MCP 集成：xai-grok-mcp

`xai-grok-mcp/src/lib.rs` 两个职责：(1) 把 `rmcp` 2.1 + `reqwest` 0.13 与工作区其余部分（reqwest 0.12）隔离；(2) 拥有 MCP 集成：`credentials`(磁盘 `$GROK_HOME/mcp_credentials.json`)/`oauth`(浏览器流 + 跨进程去重)/`servers`(传输 + 生命周期)/`liveness`/`acp_transport`/`wire`。

**传输**（`servers.rs:17`）：`StreamableHttpClientTransport`(HTTP/SSE 远程) / `TokioChildProcess`(stdio 本地)。

**MCP 工具如何接入 Tool 系统**：适配器 `McpErasedTool`（`servers.rs:1311`），包着 `McpTool`（`:1205`，持 `name`/`description`/`server_name`/`mcp_state: Arc<Mutex<McpState>>`(rmcp 客户端池)/`schema`/`meta`）。

`McpErasedTool` **直接实现** `Tool` trait（`servers.rs:1338`）：
```rust
impl xai_tool_runtime::Tool for McpErasedTool {
    type Args = serde_json::Value;      // 无类型 JSON 透传
    type Output = ToolOutput;
    fn id(&self) -> ToolId { ... qualified "server__tool" ... }
    async fn run(&self, _ctx, raw: Value) -> Result<ToolOutput, ToolError> {
        // 从 mcp_state 查 server_name 的 rmcp 客户端，
        // 调 try_call_tool (rmcp CallToolRequestParams)，
        // 鉴权失败重试一次 (force_reauth)，发事件
    }
}
```
qualified name 校验 `server__tool`（分隔符 `MCP_TOOL_NAME_DELIMITER = "__"`，`workspace-types/src/lib.rs:94`）。模型可见性由 `_meta.ui.visibility` 控制（默认模型可见；`["app"]` 工具仅 UI、永不注册给 LLM）。

注册经 `FinalizedToolset::register_tool::<T>`（`registry/types.rs:1674`），带 `namespace=MCP`/`kind=Other`/远端 `input_schema_override`（MCP schema 运行时来自服务器，无法从 Rust 类型派生）。删除按前缀 `unregister_tools_by_prefix`（`:1725`）。热重载由 `McpConfigDiff`（`:106`）驱动：配置变更时 added/removed/retained，客户端相应拆除/保活。

## 15. 配置：xai-grok-config

**TOML**，6 层合并（`loader.rs:162` 的 `ConfigLayers`），优先级（低→高，`effective_config_base` `:237`）：
1. `system_managed`(`/etc/grok/managed_config.toml`) → 2. `managed`(`$GROK_HOME/managed_config.toml`) → 3. `user`(`$GROK_HOME/config.toml`) → 4. `user_requirements` → 5. `system_requirements` → 6. `mdm_requirements`(macOS MDM `ai.x.grok`)

`deep_merge_toml`（`:419`）：嵌套表递归合并；数组**替换**不拼接。

**Campaigns**（`[[campaigns]]`，`campaigns.rs`）：叠在 base 合并之上，但 `reapply_requirements`(`:291`) 会把三个 requirements 层重新合并到顶 —— **低信任 campaign 永远不能覆盖 admin 钉死的字段**。campaign 优先级 first-id-wins，序 `requirements > remote > user > managed > system_managed`。kill switch：`GROK_CAMPAIGNS=0`。

**版本覆盖**（`version_overrides.rs`）：semver 门控的配置补丁，`apply_version_overrides(config, version)`(`:54`)。

**企业/MDM 机器**：
- `macos_managed.rs` — 读 `ai.x.grok` 域 admin-forced 的 `requirements_toml_base64`，**只信 admin-forced 值**，payload **不做 `$VAR` 展开**（防用户 env 污染受信层）
- `signed_policy.rs` — **Ed25519 签名**的托管策略信封。`EMBEDDED_DEPLOYMENT_CONFIG_PUBKEYS`(`:20`，当前 `&[]` = dark/未激活)。`verify_signed_payload`(`:108`) 用 `ring` 验签，按签名 `key_id` 选 key，要求 `typ` 标签匹配。`check_on_disk_matches`(`:243`) 逐字节校验磁盘 `managed_config.toml`/`requirements.toml` 匹配签名字节（catch 原地编辑，不只是删除）。`SignedVerdict`(`:483`)：Inactive/NoAuthenticSidecar/SidecarUnreadable/Trusted/Compromised。`fail_closed` 从**签名字节**读，本地攻击者改不了
- `managed_cache.rs` — 无签名、用户可写的同步标记（刷新提示，非防篡改）。`managed_policy_compromised_for`(`:394`) 是无网络 fail-closed 闸
- `validation.rs` — `validate_requirements()`(`:220`) 启动时调用；`fail_closed=true` + 非法 `[[version_overrides]]` → 退出码 2。`GROK_MANAGED_CONFIG_FAIL_CLOSED` 只能**收紧**不能放松

**原子写**：`fs_atomic.rs:10` `write_atomically` —— 写临时文件 `{name}.{pid}.{nonce}.tmp` 再 rename，Unix 上 mode 在临时文件创建时设置（最终文件永不以更松权限存在）。

**Shell 检测**（`shell.rs`）：Windows 级联 pwsh → powershell → Git Bash → cmd（优先 PowerShell 因 MSYS2 会破坏 `/flag` 参数）；Unix 级联 `$GROK_SHELL` → `$SHELL` → `which` → 常见目录。

**ConfigTypes 叶子**（`xai-grok-config-types`）：`PermissionConfig`（`RuleAction` 默认 `Deny`，CWE-1188）、`McpConfig`、`MemoryConfig`、`PoolConfig`、以及 ~150 字段的 `RemoteSettings`（全 `Option` + 容错反序列化器，`lib.rs:421`）。

## 16. 鉴权：xai-grok-auth

**依赖反转接缝**：定义 trait 让 `xai-grok-shell` 实现，把 shell 类型挡在 data-collector/import 图外。

- `HttpAuth` trait（`visibility.rs:1`）：`apply(builder, base_url) -> RequestBuilder`，盖 auth 头
- `AuthCredentialProvider` trait（`auth_provider.rs:39`，超 trait of `HttpAuth`）：`snapshot() -> CredentialSnapshot`（便宜磁盘重读，让兄弟进程的更新可见）、`refresh_after_unauthorized() -> bool`（拿到**不同** token 才返回 true，调用方重试一次）
- `CredentialSnapshot`（`:13`）：`token`/`user_id`/`team_id`/`deployment_id`/`api_key_id`/`organization_id`
- `StaticAuthCredentialProvider`（`:78`）：测试/裸 token 用，`refresh_after_unauthorized` 恒 false
- `AuthRetryMiddleware`（`retry_middleware.rs:11`，`middleware` feature）：reqwest 中间件，发前盖 `Authorization: Bearer {token}`；401 时循环 `refresh_after_unauthorized()` 重盖重试，最多 `max_retries` 次

**Auth 模式**：OAuth/用户 token（bearer + `X-XAI-Token-Auth` 头）/ 部署密钥（裸 Bearer，`needs_token_auth_header()=false`）/ API key（`api_key_id`）/ headless/CI（无 token）。内存 embedding provider 的 `EndpointScopedCredentials` 层加信任闸 —— session 凭证只对第一方 endpoint 保留，其余 fail-closed。

## 17. 内存：xai-grok-memory

**混合两层**：人类可读可编辑的 Markdown 文件（真相源）+ SQLite 索引（FTS5 关键词 + sqlite-vec KNN 向量）。gated by `--experimental-memory` / `GROK_MEMORY=1`（`lib.rs:19`）。

**磁盘布局**（`lib.rs:8`）：
```
~/.grok/memory/
  ├── MEMORY.md                         # 全局策展知识
  └── {workspace_hash}/                 # 每工作区目录
      ├── MEMORY.md                     # 项目级
      ├── index.sqlite                  # 本工作区 SQLite 索引
      └── sessions/YYYY-MM-DD-{slug}-{sid8}.md  # 会话日志
```

**工作区身份**（`storage.rs:600`）：目录名 `{slug}-{hash8}`，优先用 **git remote `org/repo`**（`extract_repo_identity` `:651`），所以同一仓库的所有 clone/worktree 映射到同一内存目录。临时 CWD（`/tmp/` 等）检测后静默跳过（`is_ephemeral_cwd` `:583`）。

**SQLite schema**（`schema.rs:23`）：`meta`(KV) / `chunks`(结构化元数据 + blake3 hash + source + access_count) / `chunks_fts`(contentless FTS5，BM25) / `chunks_vec`(vec0 KNN，仅 sqlite-vec 加载时)。journal 模式由 `xai_sqlite_journal` 选（本地 WAL / 网络挂载 truncate 兄弟 DB）。

**Embedding**（`embedding.rs`）：`EmbeddingProvider` trait，`ApiEmbeddingProvider` 调 OpenAI 兼容 `/embeddings` 端点，批 32，重试 3 次指数退避，默认维度 1024。`MockEmbeddingProvider` 用 blake3 哈希字节做确定性测试向量。

**混合检索**（`search.rs`）：FTS5 关键词 + 向量 KNN → 合并、归一化、过滤无内容 chunk → 时间衰减（evergreen 豁免，session 指数衰减，半衰期 7 天）→ source 权重 + 访问频率 boost → `min_score` 门控 → MMR 多样性重排（可选）→ 截断。默认权重 `text_weight=0.3`/`vector_weight=0.7`。

**MMR**（`mmr.rs`）：`MMR(d) = λ·relevance(d) - (1-λ)·max_sim(d, selected)`，用 **Jaccard on tokenized snippets**（无需 embedding），默认 `λ=0.7`。

**Chunker**（`chunker.rs`）：Markdown 感知语义分块，按 `##` header 切，超长再按段落切，续块带 overlap + 祖先 header 上下文。默认 `max_chunk_chars=1600`/`chunk_overlap_chars=320`。

**Watcher**（`watcher.rs`）：`MemoryFileWatcher` 监视 `~/.grok/memory/` 的 `.md` 变化，锁 free 设计（`ArcSwap<HashSet<PathBuf>>`，insert 用 `rcu`，take 用 `swap`）。搜索时 sync-on-search：dirty 则 reindex。

**Dream（后台记忆巩固）**（`dream.rs`）：把近期 session 日志综合成持久、有组织的 MEMORY.md（名字隐喻睡眠巩固）。三道闸（`check_dream_gates` `:40`）：`dream.enabled` / 距上次 ≥ `min_hours`(4) / session 数 ≥ `min_sessions`(3)。`DREAM_SYSTEM_PROMPT` 指示模型 Merge/Resolve(近期证伪旧的)/Convert(相对日期转绝对)/Discard(临时细节)/Preserve(决策/架构/偏好)。成功后**覆盖** workspace MEMORY.md 并清理已处理 session 文件（5 分钟 recency guard）。`DreamLock`(`dream_lock.rs`) 是 PID 锁文件，best-effort 协调（dream 幂等）。

## 18. 密钥脱敏：xai-grok-secrets

日志/导出前脱敏。公共 API：`redact_secrets`/`redact_url`/`redact_user_paths`/`redact_json_string_values`/`walk_json_strings`。

**正则模式**（`sanitizer.rs`，全 `LazyLock` 编译，`RegexSet` 预筛零分配）：API key（`sk-`/`sk_`/`xai-`，`\b` 锚定防 `task-`/`risk-` 误报）、AWS（`AKIA`/`ASIA`）、GitHub（`ghp_` 等 + `github_pat_`）、vendor（`glpat-`/`xox[abp]-`）、Google（`AIza`）、PEM 私钥块、Bearer token、JWT、`key=value` 赋值（8 字符下限防误报）。

`redact_secrets` 顺序：PEM → API keys → AWS → GitHub → vendor → Google → Bearer → JWT → URL → 赋值。常量 `[REDACTED_SECRET]`（Bearer 保留前缀）。

**URL 脱敏**（`:285`）：清 user/pass、去 fragment、脱敏敏感 query 参数（`access_token`/`api_key`/`code`/`password`/`refresh_token`/...），保留 benign 参数。

**用户路径脱敏**（`:147`）：`$HOME` → `~`，OS 用户名段 → `<user>`，segment 边界感知（`/Users/bob` 不误折成 `/Users/bobby`）。

## 19. Hooks：xai-grok-hooks

**15 个生命周期事件**（`event.rs:10` 的 `HookEventName`）：SessionStart/End、Stop(可阻断)、StopFailure、PreToolUse(可阻断)/PostToolUse/PostToolUseFailure/PermissionDenied、UserPromptSubmit、Notification、SubagentStart/Stop/End、PreCompact/PostCompact。

**反序列化别名容错**（`:37`）：接受 PascalCase/snake_case/camelCase 及从其他 agent CLI 移植的别名（`beforeShellExecution`→PreToolUse 等）。

**分发 trait**（`traits()` `:152`）：
- `GateKind`：`Observe`(输出记录,决策忽略) / `Tool`(allow/deny) / `Stop`(block/`continue:false`/`additionalContext`)
- 阻断事件：PreToolUse(gate=Tool)、Stop/SubagentStop(gate=Stop)；其余 Observe
- `MatcherPolicy`：Stop/UserPromptSubmit 为 `Ignored`(总触发)；其余按 payload 字段测试

**配置**（`config.rs`）：JSON，兼容 Claude Code `settings.json` 的 `hooks` 键。`HookSpec`(`:126`)：`type`(command/http)、`command`/`url`、`timeout`(默认 5s，stop-gate 事件 600s)、`env`。`command` 加载时 env 展开，运行时不再展开；`url` 运行时重展开（HTTP runner）。保留 env 键（`GROK_HOOK_EVENT` 等）加载时剥离，runner 最后注入（最高优先级，防 hook 伪造身份）。

**发现**（`discovery.rs`）：`HookRegistry` 按 `HookEventName` 索引。位置 `~/.grok/hooks/`(全局) + `<git-root>/.grok/hooks/`(项目)。dedup on `(canonical_event, command_raw, url_raw, matcher)`，全局先加载故赢。

**Matcher**（`matcher.rs`）：空/`*`→All；简单模式(仅 `[A-Za-z0-9_|]`)→Exact(加 Grok 别名，`Bash` 也匹配 `run_terminal_command`)；其余→Regex。**fail-open**：缺 matcher 或缺值都触发。

**Dispatcher**（`dispatcher.rs`）：
- `dispatch_pre_tool_use`(`:60`)：顺序执行，**首个显式 `deny` 短路阻断**；所有失败 fail-open
- `dispatch_stop`(`:252`)：**不短路**，所有匹配 hook 都跑（让模型一次看到所有 block 原因 + additionalContext）
- `dispatch_non_blocking`(`:357`)：Observe 事件，永不 deny

**Runner**：command hook 是子进程，envelope JSON 写 stdin；shell-vs-direct 启发式（含空格/`|`/`&`/`;`/`$`/`~` → `sh -c`，否则直接可执行路径）。输出解释按 GateKind：Observe 退 0=Success；Tool 退 0=Allow/2=Deny/其他=Failed（JSON `{"decision":"allow"|"deny"}` 优先）；Stop JSON 支持 `decision:"block"`+`reason`、`continue:false`+`stopReason`、`hookSpecificOutput.additionalContext`。输出每流 64KB 上限。

**Trust**：项目 hook 信任已迁到 shell 的 folder-trust store（`~/.grok/trusted_folders.toml`，与 repo-local MCP/LSP 同闸）。hook enable/disable 在 `$GROK_HOME/disabled-hooks`。

## 20. 插件市场：xai-grok-plugin-marketplace

**源**（`config.rs`）：`~/.grok/config.toml` 的 `[[marketplace.sources]]`，`git { url, branch }` 或 `local { path }`。官方源 `xAI Official` → `https://github.com/xai-org/plugin-marketplace.git`，首跑自动注册。`require_sha` 策略（config 或 `GROK_MARKETPLACE_REQUIRE_SHA=1`，仅收紧）—— 远程无 SHA 钉的安装 fail-closed。

**发现**（`scanner.rs`）：索引模式（`index.rs` 的 `MarketplaceIndex`，查 `.grok-plugin/marketplace.json` 等）+ 文件系统 fallback。`scan_single_plugin` 数组件：skills = 含 `SKILL.md` 子目录、`has_hooks` = `hooks/hooks.json`、`has_agents`、`has_mcp`(.mcp.json)。

**组件目录**（`catalog.rs`）：CI 生成的 `plugin-index.json`，**SHA 门控** —— URL 源条目的 catalog `sha` 必须等于 index 钉的 `sha` 否则隐藏组件（防陈旧钉展示旧组件）。

**Git 缓存**（`git.rs`）：`~/.grok/marketplace-cache/<url-hash>/`，5 分钟 TTL。clone 优先 `git2`(depth 1) 回退 `git` CLI。所有 git 命令抑制交互（`GIT_TERMINAL_PROMPT=0` 等），操作数以 `--` 终止防选项注入。

**安装**（`installer.rs`）：本地插件 copy 进 managed 存储；远程 URL 插件 clone + 钉 `git_sha`。更新是事务化（staging/backup/rollback）。`MarketplaceProvenance` 记录来源。

**与 hooks 的关系**：插件可带 hooks（`has_hooks`），经同一 `parse_hook_file`/`dispatcher.rs` 处理，只是多注入 plugin-root env（`GROK_PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` 等）。信任统一用 enable/disable（`PluginInfo.trusted` 弃用恒 true）。

**共享 DTO**（`xai-hooks-plugins-types`）：依赖仅 serde，是 `x.ai/hooks/*`/`x.ai/plugins/*`/`x.ai/marketplace/*` ACP 扩展方法的 wire 格式，shell 与 pager 共享。`PluginOrigin` 带 `#[serde(other)]` 的 `Unknown` 防新 shell 破老 pager。

## 21. 工作流：xai-workflow

**确定性、可重放、Rhai 脚本化的多 agent 编排引擎**（Cargo.toml: "Rhai-scripted dynamic workflow engine: scripts orchestrate agents through a host channel"）。工作流是 **Rhai 脚本**（不是声明式 YAML DAG），必须以 `let meta = #{ ... };` 开头（`meta.rs:166`，`WorkflowMeta`：kebab-case `name`/`description`/`when_to_use`/`phases`）。

**Host 接口**（`host.rs`）：脚本不直接碰外部，经 `tokio::mpsc` 发 `WorkflowHostRequest`，收 oneshot 回复。能力：`SpawnAgent`(子代理)、`Phase`/`Log`/`Telemetry`、`BudgetQuery`、`RenderTemplate`、`WriteScratchFile`/`ReadScratchFile`、`GitDiffSince`。`AgentOpts`(`:4`)：prompt/label/model/agent_type/capability_mode/isolation_worktree/fork_context/resume_from/output_schema。

**引擎**（`engine.rs`）：`run_workflow`(`:103`)。设 `max_ops=100_000_000`、`max_call_levels=64`、`DummyModuleResolver`、禁 `eval`。**阻断非确定性**：`timestamp()`/`sleep()`/`exit()` 全报错（"workflow scripts must be deterministic"）。控制流（complete/pause/budget/cancel）经 `ErrorTerminated` 携带 `ControlToken` 抛出，**try/catch 抓不到**（不可捕获）。

**Rhai API**（`register_host_fns` `:460`）：`agent(prompt[, opts])`、`parallel(items)`(扇出，保序，失败 null 化，cap `MAX_PARALLEL=1024`)、`phase`/`log`/`telemetry_event`、`complete`/`pause`/`await_user`(journaled pause)、`budget`/`render_template`/`write_scratch_file`/`read_scratch_file`/`git_diff_since`/`fingerprint`(SHA256)/`json_encode`。

**Host-call 分发**（`host_call` `:245`）：核心重放机制。每次调用：(1) 算 `request_hash(kind, payload)`、(2) 推进 seq、(3) 问 `journal.replay(seq, kind, hash)` —— 有记录就直接返回不打 host，kind/hash 不匹配则 `Divergence` 致命错、(4) 否则发 live 请求、(5) `journal.record`。Budget 超限/Cancelled 是**终端哨兵**，故意不 journal，以便提 cap 后 resume 重新执行。

**Journal**（`journal.rs`）：append-only JSONL，每条 `JournalEntry { seq, kind, req_hash, result, at_ms }`。`request_hash`(`:314`) = SHA256(`kind || 0x00 || canonical_json(payload)`) 前 16 字节 hex，canonical_json 递归排序 object key。`replay`(`:161`)：匹配返回值、seq 超界返回 None(live)、seq 存在但 kind/hash 不同返回 `Divergence`。**这就是确定性保证**。加载硬化：拒符号链接/非常规文件、`O_NOFOLLOW`、torn tail 截断、`MAX_JOURNAL_BYTES=64MiB`/`MAX_JOURNAL_ENTRIES=10000` cap。

**Budget**：`BudgetState { total, spent, reserved, remaining }`。每次 live agent 调用先 `ReserveAgentCalls`，可恢复终端时 release（防 resume 双计费）。`MAX_HOST_CALLS=10000` 全局 cap。

**Outcome**（`run.rs`）：`WorkflowOutcome` = Completed/Paused/BudgetExceeded/Cancelled/Failed。`PauseKind` = User/BackOff/NoProgress/Verification/Infra。

## 22. 遥测：xai-grok-telemetry

**4 个独立 sink，各有自己的闸**：
1. **产品事件**（HTTP POST 到 events 端点）+ **Mixpanel**（`client.rs`，`TelemetryMode::Enabled` 门控）
2. **外部 OTEL 流**（客户自建 OTLP collector，`external/`，`GROK_EXTERNAL_OTEL` 双重 opt-in，独立于 `TelemetryMode`）
3. **内部 OTEL tracing**（span 到 xAI `cli-chat-proxy`，`otel_layer/` + `otlp_http.rs`）
4. **Sentry**（错误/panic 报告，`sentry.rs`）

加本地磁盘日志：`unified_log.rs`(`~/.grok/logs/unified.jsonl`)、`debug_log.rs`(`--debug` firehose)、`memory_log.rs`、`hooks_log.rs`、`sampling_log.rs`、`instrumentation.rs`。

**TelemetryMode**（`config.rs:15`）：`Disabled`(默认,企业)/`SessionMetrics`(仅元数据生命周期事件)/`Enabled`(全量)。

**事件**（`events.rs`）：`TelemetryEvent` trait（`NAME` const + 可选 `external_record()` 映射到外部 OTEL）。`telemetry_event!` 宏。几十个事件跨 auth/plan/permissions/compaction/subagents/model/plugins/hooks/mcp/session/pager/rate-limit/memory。`PromptSubmitted`/`ToolCallCompleted` 带 `#[serde(skip)]` 字段（`prompt_text`/`file_path`/`parameters`）**只**走外部 OTEL 流（内容闸后），永不进产品事件/Mixpanel。

**扇出**（`session_ctx.rs`）：`log_event`(`:137`) 先 `external::emit` 再产品事件；`log_session_event`(`:170`) 在 Enabled+SessionMetrics 都发；`log_session_event_with_origin`(`:189`) 故意**不**扇出外部（workspace 是不同进程/受众）。

**外部 OTEL**：6 个 counter（`grok_code.session.count`/`token.usage`/`turn.count`/`tool.decision`/`tool.usage`/`error.count`）+ 18 个 log-record 事件名。`ExternalKey` 枚举是闭类型编译期强制 allowlist。`ContentGates`（`log_user_prompts`/`log_tool_details`，默认 off，仅收紧）。remote policy **仅收紧**（可 force_disable/lock，不可启用）。

**脱敏 chokepoint**（`redact_common.rs`）：`redact_owned`(secrets + user_paths) 共享给内部 OTEL span 和外部客户流。`url_origin` 把 URL 降到 `scheme://host[:port]`。

**Sentry**（`sentry.rs`）：DSN 从 `SENTRY_DSN` 或 build-time。`before_send` 用 `Scrubber` 全量脱敏（`redact_secrets` + home→`~` + username→`<user>`），清 `server_name`，丢 broken-pipe/disk-full panic。`TRACES_SAMPLE_RATE=0.01`。

## 23. 模型：xai-grok-models

**薄 JSON 加载器**，不是硬编码模型注册表（`lib.rs`）。无 Rust enum/struct 存模型属性。所有模型定义在 `default_models.json`，编译期 `include_str!` 嵌入（`:12`）。

`DefaultModels`(`:14`)：`default`/`web_search`/`image_description`/`session_summary` + `models: Vec<DefaultModelEntry>`。`DEFAULTS: LazyLock`(`:31`) 首次访问解析，断言 `default` 模型在 `models` 中。

当前 baked 默认：`default="grok-4.5"`、`web_search="grok-4.20-multi-agent"`、`image_description="grok-4.5"`、`session_summary="grok-4.5"`。`models` 数组只有 `grok-4.5` 一个完整条目（`context_window=500000`、`api_backend="responses"`、`supports_reasoning_effort`、`reasoning_efforts`=[high/medium/low]、`auto_compact_threshold_percent=80`）。**无 pricing 字段**。

选择优先级（`lib.rs:4`）：`CLI > ENV > config.toml > remote > 这些 default`。

## 24. 一次 turn 的完整数据流

```
用户在 TUI 输入
 -> pager 经 ACP session/prompt 发给 agent(本地或 leader)
 -> MvpAgent.prompt 查 SessionHandle, 发 SessionCommand::Prompt
 -> session actor 的 run_session 排入 prompt_queue
 -> maybe_start_running_task 弹队首, 起 process_conversation_turn
 -> 预采样收尾(插话/memory reminder/auto-compact 检查)
 -> chat_state.build_request(历史+工具+系统提示)
 -> run_turn_via_sampler -> SamplerActor.submit_and_collect
 -> 模型流式响应(Responses API), SamplingEvent 实时翻译成 ACP SessionUpdate 推 UI
   (Text->AgentMessageChunk, Reasoning->thought_chunk, ToolCallDelta->ToolCallDeltaChunk)
 -> 收到 ConversationResponse, 提取 tool_calls
 -> 若空: TodoGate(有待办 todo 则注入 nudge 再一轮) 否则 TurnOutcome::Completed
 -> 若有: 每个 tool_call:
          prepare_tool_call(权限 + PreToolUse hook[可 deny] + 参数解析)
          同文件写经 per-path mutex 串行
          dispatch_tool -> WorkspaceOps.call_tool:
              bash/read/edit -> WorkspaceClient -> workspace 进程
              MCP 工具 -> mcp_dispatcher -> McpErasedTool -> rmcp
              内置工具 -> FinalizedToolset 直接跑
          工具结果(ToolStream Terminal)回填为 tool 消息 push 到 chat_state
 -> 检查 max_turns + preflight 溢出压缩
 -> continue 回到循环顶(带着工具结果再调模型)
 -> 直到无 tool_call -> 最终回复经 ACP session/update 流回 TUI 渲染
 -> 全程: telemetry 打点、secrets 脱敏、unified_log 记录、hunk_tracker 记 Agent 写
```

## 25. 关键设计决策

1. **ACP 作为统一接缝**：TUI/IDE/relay/headless 全走同一协议，agent 运行时可 in-process 也可拆成 leader 进程，前端无感。
2. **每会话独占线程的 actor 模型**：单线程 tokio + LocalSet，`!Send` 类型自由用，会话间隔离。
3. **Workspace 独立进程化**：把高危主机操作隔离，支持沙箱/云沙箱/热替换工具集；同一 RPC 接口 Local/Proxy 双模。
4. **Leader 常驻 + 重放**：长会话跨客户端共享，断线重连靠缓存 ACP 状态重放；新版本驱逐旧版本防抖。
5. **确定性工作流**：Rhai + journal 让多 agent 编排可恢复、可重放，阻断非确定性原语。
6. **分层信任配置**：6 层 TOML + MDM + Ed25519 签名信封 + fail-closed，面向企业部署；admin requirements 永远赢。
7. **内存的"做梦"机制**：session 日志 → dream → 长期 MEMORY.md，模仿睡眠记忆巩固。
8. **工具统一 trait + 流式**：原生 async-in-trait 不装箱，MCP/LSP/内置/codex/opencode 全统一接入，`[Progress*, Terminal]` 流不变量。
9. **沙箱进程级网络放开 + 子进程 seccomp 阻断**：agent 能调 LLM 但子进程不能外联。
10. **遥测多 sink 独立闸 + 分层脱敏**：产品事件/外部 OTEL/内部 OTEL/Sentry 各自门控，内容字段只走外部流且需双重 opt-in。

## 26. Crate 索引

### 入口与 UI
| Crate | 职责 |
|---|---|
| `xai-grok-pager-bin` | 组合根二进制 |
| `xai-grok-pager` | TUI（scrollback/prompt/modals/render） |
| `xai-grok-pager-render` | 渲染 |
| `xai-grok-pager-minimal` | 最小渲染模式（IoC 注入） |
| `xai-grok-pager-pty-harness` | PTY harness |
| `xai-grok-markdown(-core)` | Markdown 渲染 |
| `xai-grok-mermaid` | Mermaid 图 |
| `xai-ratatui-inline`/`xai-ratatui-textarea` | ratatui 扩展 |

### Agent 运行时
| Crate | 职责 |
|---|---|
| `xai-grok-shell` | agent 运行时主机 + leader/stdio/headless 入口 |
| `xai-grok-shell-base` | 基础（env/util/cpu_profile），独立编译 |
| `xai-grok-shell-session-support` | managed_mcp 抽取 |
| `xai-grok-agent` | Agent/AgentBuilder/AgentDefinition/CompactionPolicy/系统提示 |
| `xai-agent-lifecycle` | 宿主无关 hook 贡献者系统 |
| `xai-chat-state` | 会话状态 actor |
| `xai-grok-sampler` | 采样 I/O actor |
| `xai-grok-sampling-types` | 采样纯数据类型 |
| `xai-grok-compaction` | 压缩引擎（传输无关） |
| `xai-prompt-queue` | 队列共享类型 |
| `xai-grok-subagent-resolution` | 子代理解析纯逻辑 |
| `xai-workflow` | Rhai 工作流引擎 |
| `xai-grok-models` | 模型 JSON 加载器 |

### 工具与工作区
| Crate | 职责 |
|---|---|
| `xai-tool-runtime` | `Tool`/`ToolDyn`/`ToolStream` 统一 trait |
| `xai-tool-protocol` | 工具 wire 类型/JSON-RPC/注册 |
| `xai-tool-types` | `ToolDescription` 等叶类型 |
| `xai-grok-tools` | 工具实现 + registry |
| `xai-grok-tools-api` | 工具 facade（config 校验/slash 命令） |
| `xai-grok-workspace` | workspace 服务端 |
| `xai-grok-workspace-client` | `WorkspaceClient` |
| `xai-grok-workspace-types` | workspace wire 类型 |
| `xai-grok-sandbox` | nono 沙箱 |
| `xai-grok-mcp` | MCP 集成（rmcp 隔离） |
| `xai-fast-worktree` | CoW worktree |
| `xai-gix-status` | gix git status |
| `xai-hunk-tracker` | hunk diff 跟踪 |
| `xai-computer-hub-core/sdk/mcp-adapter` | ToolHarness/LocalRegistry/Hub |

### 外围
| Crate | 职责 |
|---|---|
| `xai-grok-config(-types)` | 分层 TOML 配置 + 签名策略 |
| `xai-grok-auth` | 鉴权 trait 接缝 |
| `xai-grok-memory` | 混合内存 + dream |
| `xai-grok-secrets` | 密钥脱敏 |
| `xai-grok-hooks` | hook 系统 |
| `xai-hooks-plugins-types` | hooks/plugins DTO |
| `xai-grok-plugin-marketplace` | 插件市场 |
| `xai-grok-telemetry` | 多 sink 遥测 |
| `xai-grok-env` | 生产端点默认 + env 覆盖 |
| `xai-grok-paths` | 路径包装类型 |
| `xai-grok-http` | HTTP 客户端 |
| `xai-grok-update`/`xai-grok-version` | 自动更新/版本 |
| `xai-grok-sandbox` | 沙箱 |
| `xai-acp-lib` | ACP 类型化封装 |
| `xai-grok-voice` | 语音 |
| `xai-grok-announcements` | 公告 |
| `prod/mc/cli-chat-proxy-types` | chat proxy wire 类型（含签名信封） |

## 27. 关键文件速查表

| 想看 | 去这里 |
|---|---|
| 程序入口 | `crates/codegen/xai-grok-pager-bin/src/main.rs:1639`(main) / `:1717`(async_main) |
| CLI 定义 | `crates/codegen/xai-grok-pager/src/app/cli.rs:8`(Command) / `:330`(AgentCmd) |
| TUI 入口 | `crates/codegen/xai-grok-pager/src/app/mod.rs:442`(app::run) |
| headless 单轮 | `crates/codegen/xai-grok-pager/src/headless.rs:821` |
| agent 四入口 | `crates/codegen/xai-grok-shell/src/agent/app.rs:300/420/928` + `server.rs:458` |
| leader 连接 | `crates/codegen/xai-grok-shell/src/leader/mod.rs:1205`(connect_or_spawn) |
| leader IPC 路由 | `crates/codegen/xai-grok-shell/src/leader/server.rs:1505` |
| MvpAgent | `crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs:597` |
| ACP Agent trait 实现 | `crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:844/1231/2006` |
| 外层循环 | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs:116` |
| 内层 ReAct 循环 | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs:1798` |
| 流式事件翻译 | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:2377` |
| 工具分发 | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_dispatch.rs:13` |
| Tool trait | `crates/common/xai-tool-runtime/src/tool.rs:36` |
| 工具注册 | `crates/codegen/xai-grok-tools/src/registry/types.rs:663` |
| 工具清单 | `crates/codegen/xai-grok-tools/src/implementations/mod.rs` |
| MCP 工具适配 | `crates/codegen/xai-grok-mcp/src/servers.rs:1311`(McpErasedTool) |
| workspace client | `crates/codegen/xai-grok-workspace-client/src/lib.rs:133` |
| workspace 服务端 | `crates/codegen/xai-grok-workspace/src/lib.rs` / `handle.rs` |
| 检查点/回退 | `crates/codegen/xai-grok-workspace/src/session/checkpoint.rs:90` |
| 沙箱 | `crates/codegen/xai-grok-sandbox/src/lib.rs:128` / `profiles.rs:60` |
| 配置加载 | `crates/codegen/xai-grok-config/src/loader.rs:162`(ConfigLayers) / `:237`(合并) |
| 签名策略 | `crates/codegen/xai-grok-config/src/signed_policy.rs:20` / `:108` / `:483` |
| 鉴权 trait | `crates/codegen/xai-grok-auth/src/auth_provider.rs:39` |
| 内存 schema | `crates/codegen/xai-grok-memory/src/schema.rs:23` |
| 内存检索 | `crates/codegen/xai-grok-memory/src/search.rs:146` / `backend.rs:334` |
| dream | `crates/codegen/xai-grok-memory/src/dream.rs:40` |
| 密钥脱敏 | `crates/codegen/xai-grok-secrets/src/sanitizer.rs` |
| hooks 事件 | `crates/codegen/xai-grok-hooks/src/event.rs:10` |
| hooks 分发 | `crates/codegen/xai-grok-hooks/src/dispatcher.rs:60`(pre_tool) / `:252`(stop) |
| 插件市场 | `crates/codegen/xai-grok-plugin-marketplace/src/scanner.rs:20` / `installer.rs` |
| 工作流引擎 | `crates/codegen/xai-workflow/src/engine.rs:103`(run) / `:245`(host_call) / `:460`(API) |
| 工作流 journal | `crates/codegen/xai-workflow/src/journal.rs:161`(replay) / `:314`(hash) |
| 遥测事件 | `crates/codegen/xai-grok-telemetry/src/events.rs` |
| 模型默认 | `crates/codegen/xai-grok-models/default_models.json` |
| chat proxy wire | `prod/mc/cli-chat-proxy-types/src/deployment_config_types.rs:33`(SignedPayload) |

---

> **说明**：本文档基于某次代码探索，行号会随代码演进漂移；以符号名（函数/结构/trait）为准定位。
> 仓库非 git 仓库（本地副本），本文档为本地学习笔记，不会进入上游 monorepo。
