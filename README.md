# 常驻 Bot · P0-A

一个**跑在用户本机常驻进程**上的最小可运行闭环：命名 Bot、持久上下文、主动观察、并发推进、连续处理，低打扰、人在回路。执行面衍生自 DeepSeek `dsh`（`@deepseek-ai/dsh`）的源码架构，通过可替换的 `DshExecutor` 接入（详见下文「DSH 执行面」）。
 **状态（原型）**：四条定义性能力已落地并通过确定性 + 历史真模型验收，但**长文档分批 compose 之后的真模型全套回归尚未重跑**（需新 key）；另有已知上限（SOFT 触发率非 100%、定时器延迟长尾、材料有界）。完整进度、验收分层与待验证项见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)。

> **给 AI agent 的规矩**：动手改代码或跑长任务前，先读项目根 [AGENTS.md](./AGENTS.md)。两个第三方工程技能库在 `.agents/skills/`（Addy Osmani 25 个 / Lauren Tan pstack 63 个），与 AGENTS.md 冲突时以 AGENTS.md 为准。当前进度与验收见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)；产品方案见 [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md)。
> **许可证**：MIT，见 [LICENSE](./LICENSE)。`.agents/skills/` 内两个第三方库各有自己的 MIT LICENSE 与出处，随仓库保留。
> 这一版**没有云电脑、VNC、GUI 屏幕**，也不承诺「关掉客户端仍继续执行」；执行在本机进程里，客户端关了进程还在、任务照样跑完，进程停了就停。

## 跑起来

Node ≥ 20（验证用 Node 24）。**零依赖，不需要 `npm install`。**

```sh
npm start                 # 打开 http://127.0.0.1:3080
npm test                  # 265 个闭环测试
npm run acceptance        # DOM 40 + HTTP 203 = 243 项（见 acceptance/README.md）
npm run acceptance:real   # 真模型验收入口；需 key，无 key 时 NOT_VERIFIED
npm run acceptance:composition
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3080` / `127.0.0.1` | **只监听本机**，不要暴露公网（无鉴权） |
| `DATA_DIR` | `./.data` | Bot / transcript / 交付物 / 凭据目录 |
| `DEEPSEEK_API_KEY` | 空 | 设置后从 `MockModel` 切到 `DeepSeekModel`；**只从环境变量读，不落盘** |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点，可指向第三方代理（写到 `/v1` 级） |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `EXECUTOR_PROVIDER` | `local` | `local` / `dsh`（全量）/ `gray`（按 Bot 灰度） |
| `OBSERVER_MODE` | `observe` | `observe`（只出卡片）/ `auto`（复查后自动执行）/ `off` |
| `MAX_CONCURRENT_TURNS` | `3` | 同 Bot 并发 turn 上限；`1` 退回严格串行 |

Watchdog 三个间隔（`WATCHDOG_INTERVAL_MS` 5000 / `HEARTBEAT_MS` 15000 / `STALL_MS` 30000）。没有 key 也能完整跑通：默认 `MockModel`（确定性离线模型）。

### 接真实模型

```sh
DEEPSEEK_API_KEY='<你的密钥>' npm start
```

第三方 OpenAI 兼容代理需三个变量一起给（端点写到 `/v1` 级）。`GET /api/health` 的 `model` 字段显示 `deepseek` 即已切换。密钥只从环境变量读取，代码与状态目录都不保存；用第三方代理等于把对话内容交给该服务，请自行确认合规。

## 在界面里试

1. 左侧新建一个 Bot，例如「小助手」
2. 发「帮我写一份周报」→ 看到活动摘要、回复，以及一个**可下载交付物链接**
3. 发「执行命令 `node --version`」→ 出现**审批卡片**，批准后才执行
4. 顶部「停止」可中断；「展开明细」才显示工具调用（默认不展示）
5. 关掉浏览器再打开，或重启 `npm start`，对话与上下文都还在

## 核心能力（速览）

| 能力 | 实现 |
|---|---|
| 命名 Bot + 持久上下文 | 每 Bot 一个 append-only JSONL（`src/journal.mjs`），`bot.memory` 累积 |
| 「已接纳 ≠ 已完成」 | `POST messages` 返回 **202 + turnId**，结果走 transcript / SSE |
| 幂等与游标续传 | `clientNonce` 去重；`GET transcript?cursor=` 增量；SSE 重连自动补 |
| 审批边界 | 有后果的动作生成类型化卡片，停在 `waiting_approval` |
| 凭据值旁路 | `POST /api/secrets` 返回 `ref`，消息里用 `@secret:<ref>` |
| 交付物转链接 | 返回 `/api/artifacts/:id`，**不返本机路径** |
| 长文档分页续读 / 交付不丢页 | `browse` 一次 16K，显式 `@offset` 续读；`write_artifact` 读回本 turn 全部页并按 16000 预算分批 compose，任一批失败降级到全文兜底 |
| 错误按族中文化 / 重复降权 | 结构化 `family`/`code` 只在 journal；时间线给中文与下一步；同 Bot 同轮同款瞬断只说全一次，后续降成淡行，每条仍占一行不折叠 |
| 重启如实恢复 | `Engine.recover()` 把未完成 turn 标为中断，不假装成功 |

**P1**（Skill / Routine / 群聊 Room）：`POST /api/skills/from-turn` 从已完成任务存技能；`POST /api/routines` 定时/事件自动化（窄匹配，不监听「每条消息」）；`POST /api/rooms` 建群，`mentions` 只唤醒被 @ 的 Bot。能力靠对话卡片唤出，不新增后台页。

**P2**（渠道 / 团队额度）：`ChannelBook` 具名入站端点（webhook/slack/email）绑 Bot + 关键词窄匹配，token 只存 SHA-256；`TeamBook`/`QuotaBook` 每日 turn 额度，`sendMessage` 接纳前检查、渠道不绕过。

## 三条主线

- **主动观察**（回到「一个它 + 一条时间线」）：`src/observer.mjs` 四级闸门（程序粗筛 → low 粗判 → observe 默认只出卡片、不自动派 turn → auto 才 high 复查自动执行）。观察结果全部落在对话时间线，不新增后台页。接口 `POST /api/observations`、`/flush`、`POST /api/cards/:id/act {action:'delegate'|'dismiss'}`。
- **并发 turn**（一个它，同时推进几件事）：`src/turns.mjs` 硬槽位 `TurnCoordinator`（默认 3，超出排队补位、审批释放槽位）+ 唯一出口 `ReplyOutbox`（所有回复带 `viaOutbox:true`）。并行时回复加 `taskLabel`，用户看到的是「一个它」在说。
- **Thread 串联 + 长任务可见/可中断/恢复**：`src/threads.mjs` 按 `botId+source+entity` 程序分组，`afterSeq`/`throughSeq` 增量召回，不做全量重放；`src/watchdog.mjs` 只做可见性 + 把决定权交回人，不自动杀任务、不静默续跑。接口 `POST /api/threads/ingest`、`POST /api/turns/:id/resume`、`POST /api/watchdog/tick`。

## DSH 执行面（可选 / 灰度，默认关闭）

`@deepseek-ai/dsh@0.2.1-rc.5` 已在本机验证：`dsh headless --json` 经 `DEEPSEEK_BASE_URL` 接代理返回结果。`DshExecutor` 以 **CLI 为集成边界**（隔离其 pre-stable 内部 API），命令与文件仍委托 `LocalExecutor` 保持白名单/审批，检索类动作走 `dsh headless`。

```powershell
$env:EXECUTOR_PROVIDER='dsh'
$env:DSH_CLI_ENTRY='<dsh 安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js'
$env:DSH_HOME='<独立的 DSH home>'
npm start
```

没装 dsh 或未开开关时一律走 local，闭环不受影响。`DSH_PINNED_VERSION='0.2.1-rc.5'`：首次调用跑 `dsh --version` 校验，漂移即报 `DSH_VERSION_MISMATCH`；会话按 Bot 持久化复用。`test/dsh-contract.test.mjs` 用 fake CLI 做跟版回归，不需装那 616 个包。

## 没有做的（按 v3 约束）

云电脑 / VNC / 每 Bot 独立屏幕 / 关客户端仍执行；A2A、跨月记忆、Thread↔Worker 多对多订阅与完整链式召回 / Inline & Spill、独立语义 Watchdog Session；把 DSH 切成默认执行面（当前仅可选开关）。运维面冻结，不再加后台页签。

## 架构

```
web/           极简客户端（原生 HTML/CSS/JS + SSE）
src/server.mjs  HTTP + SSE 常驻进程
src/engine.mjs  turn 状态机、审批、中断、记忆、连续性
src/journal.mjs append-only transcript + 游标 + nonce（唯一上下文源）
src/store.mjs   原子写 Bot/turn/approval/secret/artifact 状态
src/features.mjs P1: SkillBook / RoutineScheduler / RoomHub
src/cards.mjs   类型化卡片：生成、动作分派、幂等、initiator 记录
src/p2.mjs      P2: TeamBook / QuotaBook / ChannelBook
src/observer.mjs 主动观察循环：四级闸门 + 去重 + 限流重排队
src/turns.mjs   并发槽位 / 排队 / 统一回复出口
src/threads.mjs Thread 串联 + seq 水位增量召回
src/watchdog.mjs 轻量 Watchdog：进度心跳 / 停滞卡片 / 不自动杀任务
src/providers.mjs
  ├─ ModelProvider     MockModel | DeepSeekModel
  ├─ ExecutorProvider  LocalExecutor(默认) | DshExecutor(可选)
  └─ SecretBroker      值只落本机状态目录
```

执行面是可替换 provider，接口四个方法：`capabilities()` / `runCommand()` / `writeArtifact()` / `browse()`。`LocalExecutor.browse()` 在 `DATA_DIR/materials/` 做真实本机检索（文本/代码文件都认，限 40 文件、单文件 256KB、最多 8 条片段），命中即写入 `tool/call` 并标明「本机 materials/ 命中 N 处」，没命中如实说没有、不编造。

## 安全边界（原型）

- 只监听 `127.0.0.1`，**无鉴权**，不要放公网
- 密钥只在进程环境变量，不写入代码或 `.data/`；用第三方代理请求会经该服务，聊天/命令行里贴的密钥建议轮换
- 本机命令只放行白名单（`node/git/npm/pnpm/python`）且须经审批；`execFileSync` 不走 shell
- 敏感值不进 transcript，但仍以明文存 `DATA_DIR/state/secret.*.json` —— 生产需换 OS 凭据库 / KMS
- 单进程、单用户，无多租户隔离、无配额计费、无审计导出

## 进度与验收

当前进度、验收分层、已知上限与待验证项见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)。验收脚本、SHA-256 清单与真模型跑法见 [acceptance/README.md](./acceptance/README.md)。
