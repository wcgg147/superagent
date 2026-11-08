# 常驻 Bot · P0-A

一个**跑在用户本机常驻进程**上的最小可运行闭环。对应方案文档 [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md) v3 的 P0-A（并带入 P0-B 里成本最低的几项）。

> **给 AI agent 的规矩**：动手改代码或跑长任务前，先读项目根 [AGENTS.md](./AGENTS.md)（产品大方向、硬约束、禁改的底层代码、验收规矩）。项目内两个工程技能库在 `.agents/skills/`：Addy Osmani 的 25 个工程技能、Lauren Tan 的 pstack 63 个技能；两者与 AGENTS.md 冲突时以 AGENTS.md 为准。项目当前进度与验收状态见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)；产品方案与调研依据见 [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md)。
> **许可证**：MIT，见 [LICENSE](./LICENSE)。仓库内的 `.agents/skills/` 两个第三方技能库各有自己的 MIT LICENSE 与出处说明，随仓库保留。

> 这一版**没有云电脑、没有 VNC、没有 GUI 屏幕**，也不承诺「关掉客户端仍继续执行」。执行就在本机进程里，客户端关了、进程还在，任务照样跑完；进程停了就停。

## 跑起来

需要 Node ≥ 20（本机验证用的是 Node 24.14）。**零依赖，不需要 npm install。**

```sh
npm start
# 打开 http://127.0.0.1:3080
```

```sh
npm test                     # 265 个闭环测试
npm run acceptance           # DOM 40 + HTTP 203 = 243 项（见 acceptance/README.md）
npm run acceptance:real      # §5 第 3/4 步入口；需 key，无 key 时明确 NOT_VERIFIED
npm run acceptance:composition  # 组合 5 脚本：自动起 3211 服务 + 夹具 + 停服务
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3080` | 监听端口 |
| `HOST` | `127.0.0.1` | **只监听本机**，不要暴露到公网（当前无鉴权） |
| `DATA_DIR` | `./.data` | Bot / transcript / 交付物 / 凭据目录 |
| `DEEPSEEK_API_KEY` | 空 | 设置后自动从 `MockModel` 切到 `DeepSeekModel`；**只从环境变量读取，不写入任何文件** |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点，可指向第三方代理（写到 `/v1` 这一级） |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名；用第三方代理时需设为其支持的模型 |
| `EXECUTOR_PROVIDER` | `local` | `local`（默认）/ `dsh`（全量）/ `gray`（按 Bot 灰度，需显式 opt-in） |
| `DEEPSEEK_REASONING_EFFORT` | `high` | 默认推理预算；观察粗判用 `low`、复查用 `high`，不写死模型档位 |
| `OBSERVER_MODE` | `observe` | `observe`（默认，只出卡片）/ `auto`（高 effort 复查后自动执行）/ `off` |
| `MAX_CONCURRENT_TURNS` | `3` | 同一 Bot 同时跑的 turn 上限；设为 `1` 退回严格串行 |
| `WATCHDOG_INTERVAL_MS` | `5000` | 轻量 Watchdog 巡检间隔（毫秒） |
| `WATCHDOG_HEARTBEAT_MS` | `15000` | 单步多久没进展就写一条低打扰心跳 |
| `WATCHDOG_STALL_MS` | `30000` | 单步多久算停滞，出一张「停掉 / 继续等」卡片；**不会自动中断** |

没有 API key 也能完整跑通闭环：默认用 `MockModel`（确定性离线模型）。

### 接真实模型

密钥只从环境变量读取，代码和状态目录都不会保存它。官方 DeepSeek：

```sh
DEEPSEEK_API_KEY='<你的密钥>' npm start
```

第三方 OpenAI 兼容代理需要三个变量一起给（端点写到 `/v1` 这一级）：

```sh
DEEPSEEK_API_KEY='<你的密钥>' \
DEEPSEEK_BASE_URL='https://api.qnaigc.com/v1' \
DEEPSEEK_MODEL='deepseek/deepseek-v4-flash' \
npm start
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY='<你的密钥>'
$env:DEEPSEEK_BASE_URL='https://api.qnaigc.com/v1'
$env:DEEPSEEK_MODEL='deepseek/deepseek-v4-flash'
npm start
```

`GET /api/health` 的 `model` 字段显示 `deepseek` 即已切到真实模型。在该代理上验证可用的是 `deepseek/deepseek-v4-flash`（能稳定返回结构化 actions）；`GET /models` 可列出全部模型，早期不少已退役。模型层对 Markdown 围栏、缺失 `reply`、未知动作都做了容错。

> 数据会发往你配置的 `DEEPSEEK_BASE_URL`。用第三方代理等于把对话内容交给该服务，请自行确认合规。

## 在界面里试

1. 左侧新建一个 Bot，例如「小助手」
2. 发「帮我写一份周报」→ 看到活动摘要、回复，以及一个**可下载的交付物链接**
3. 发「执行命令 `node --version`」→ 出现**审批卡片**，批准后才执行
4. 顶部「停止」可中断；「展开明细」才显示工具调用（默认不展示，极薄交互）
5. 关掉浏览器再打开，或重启 `npm start`，对话与上下文都还在

## 已跑通的核心

| 能力 | 实现 |
|---|---|
| 命名 Bot + 持久上下文 | `src/journal.mjs` 每 Bot 一个 append-only JSONL；`bot.memory` 累积 |
| 「已接纳 ≠ 已完成」 | `POST messages` 返回 **202 + turnId**，结果走 transcript / SSE |
| 幂等与游标续传 | `clientNonce` 去重；`GET transcript?cursor=` 增量拉；SSE 重连后自动补 |
| 乐观发送 | 前端先画一行「已发送」，收到权威条目后替换 |
| 极薄交互 | `tool/call` 写入日志但**默认不渲染**，只显示活动摘要 |
| 活动摘要 + 一键中断 | `interrupt` 是持久事件；后台步骤不会把状态覆盖回 running |
| 审批边界 | 有后果的动作生成类型化卡片，停在 `waiting_approval` |
| 凭据值旁路 | `POST /api/secrets` 返回 `ref`；消息里用 `@secret:<ref>`，transcript 只留「[已提供]」 |
| 交付物转链接 | 返回 `/api/artifacts/:id`，**不返回本机路径** |
| 错误按族分标题 | transport / entitlement / agent 三族，修「额度用完只显示 Bot failed to respond」 |
| 重启如实恢复 | `Engine.recover()` 把未完成 turn 标记为中断，不假装成功 |
| 本地快照 | 刷新后自动回到上次的 Bot（localStorage），前端先渲染再拉增量 |
| 长文档分页续读 | 指名文件一次仍只给 16K；模型显式写 `文件名 @16000` 可再读一页（返回 `page`/`nextOffset`）。系统不自动翻页，越界诚实返回空；该次改动只碰 `providers.mjs` |
| 长文档交付不丢页 | `write_artifact` 从时间线读回本 turn 全部 browse 页（`collectTurnMaterials`），compose 按既有 16000 预算分批再拼接（`splitMaterialsForCompose`）；任一批失败整体降级到全文材料兜底并标 `composeDegraded`，不拼接半截 |
| SSE 断线可见 | `EventSource` 断开时顶部显示「连接断了，正在重连…」，重连后隐藏并按游标补拉；状态条不写时间线、不碰游标与 SSE 过滤 |
| 交付物诚实信号 | 卡片按时间线字段中文化展示「按 N 页材料分段整理」「模型没写成，已用原文兜底」「材料有界，请分批续读」「内容来自本机检索材料」；正常单批 compose 零新增提示，不静默降级 |
| 错误时间线中文化 | 结构化 `family`/`code` 只在 journal 内部；时间线按类给人话与下一步：代理瞬断（含 `NO_CREDENTIAL`）→「模型服务这次没接上，直接再发一次就行，不用改本机配置」，额度 → 单独醒目说明，网络瞬断 / 停步可续跑 → 柔和低打扰，程序侧明确拒绝 → 保留诚实中文原文；前端纯函数脱敏，不出现内部变量名，正常路径零新增 `.row` |
| 重复错误低打扰 | 同一 Bot / 同一轮里同款可重试瞬断只说全一次，后续降成极淡的「· 同样的问题，第 N 次」；额度与程序侧明确拒绝永不降权；**每条事件仍占一行、seq 逐条记账**，不折叠、不吞时间线（DOM/API 不丢不重不多） |

## P1 已跑通：Skill / Routine / 多 Bot 群聊

- **Skill**：`POST /api/skills/from-turn` 从已完成任务生成可复用指令；`POST /api/skills/:id/run` 在新输入上复用。未完成的任务不能存成技能。
- **Routine**：`POST /api/routines` 创建定时或事件触发的自动化；`POST /api/events/ingest` 走**窄匹配**（source + phrase 必须同时命中），宽泛「每条消息」监听刻意不支持；调度在控制面且状态持久化，不随执行进程重启丢失。`/toggle`、`/test`、`DELETE` 可管理。
- **Room**：`POST /api/rooms` 建群；`POST /api/rooms/:id/messages` 扇出给成员 Bot，`mentions` 只唤醒被 @ 的 Bot。Room 不出现在 `/api/bots` 列表里。

**前端**：主聊天界面不变，顶部只有一个「工作台」按钮，打开右侧**默认收起**的查看/管理抽屉（技能 / 自动化 / 群聊 / 渠道 / 团队五个页签）；能力靠对话里的卡片唤出，主动观察的淡行与卡片也在这条时间线上。群聊里用「只发给」下拉做 @ 指定。刷新页面会记住上次选中的 Bot。已用 jsdom 做真实 DOM 运行时冒烟 22 项。

## 渐进披露：能力由卡片唤出

对标 Grok「界面只放表达意图的入口，执行能力由 Agent 用结构化卡片唤出」：

- 一轮**有实质工作**的任务完成后，对话里自动浮现**一张** `followup-offer` 卡片，三个动作：「存成技能」「每小时自动跑」「不用了」。纯闲聊不出卡片（低打扰）。**连续做几件事不会堆一叠一样的卡片**：同一 Bot 只保留一张未决卡片；用户点了「存成技能 / 自动化」才再给下一次机会，点了「不用了」则一天内不再提议。这条规则来自真实任务剧本跑批——连续三件真事原本会冒出三张一模一样的卡片。
- 卡片是写入 transcript 的**类型化事件**（`card` / `card/resolved`），不是 Markdown 按钮；动作回流带 `initiator: 'card_action'`，允许哪些动作由程序决定。
- 点一下就生成 Skill 或 Routine，卡片就地变成「已保存 / 已忽略」，不跳页、不填表；重复点击幂等。
- 抽屉降级为**查看与管理**，顶部三个常驻按钮收敛成一个「工作台」。

接口：`GET /api/cards/:id`、`POST /api/cards/:id/act {action}`。

## 主动观察：回到「一个它 + 一条时间线」

渠道 / 额度 / 团队属于运维面；这一节是 Super-agent 的**主动性**，刻意不新增后台页，观察结果全部落在对话时间线上。

`src/observer.mjs` 的 `ObservationLoop` 常驻消费环境事件，四级闸门（最便宜的先做，弱模型不被托付整个判断）：

1. **程序粗筛**（Fast Path）：空 / 太短 / 纯符号 / 噪音来源 / 重复指纹直接挡掉，**不调用模型**
2. **低 effort 粗判**：`model.judge({ effort: 'low' })` 返回 `{ worthwhile, reason }`
3. **observe 默认**：值得做的事只写一条淡 `observation` 行 + 一张 `observation-offer` 卡片（「交给它」/「不用了」），**不自动派 turn**；被判否的连时间线都不写
4. **高 effort 复查**：仅 `OBSERVER_MODE=auto` 时用 `effort: 'high'` 再判一次，两次都过才 `sendMessage`

`OBSERVER_MODE=off` 全停。点「交给它」才产生真正的 turn，人在回路、低打扰；去重指纹持久化，重启后不重复打扰。

**模型契约**（`src/providers.mjs`，对齐 harness 的 wire 扩展，不需要官方 key）：system prompt **稳定**、动态信息只放尾部 user（对齐 `systemPromptUpdate: in-history` 保 prefix cache）；`reasoning_effort` / `reasoning_content` / session 元数据走**旁路**，不进 messages、不增加输入 token；`judge` 用独立稳定的观察哨 prompt；`content` 为空时从 `reasoning_content` 兜底；网关不认 `response_format` / `reasoning_effort` 时降级重发。上层只依赖结构化动作，不猜未发布模型的规格。

接口：`POST /api/observations {source,text,botId?}`、`GET /api/observations`（状态计数）、`POST /api/observations/flush`（手动驱动一轮）、`POST /api/cards/:id/act {action:'delegate'|'dismiss'}`。

## 同一 Bot 并发 turn：一个它，同时推进几件事

`src/turns.mjs` 把「并行」做成有上限、可观察、只有一个出口的能力，而不是让多个 Worker 各刷各的屏：

- **`TurnCoordinator`**：`MAX_CONCURRENT_TURNS`（默认 `3`）硬槽位。超出的 turn **排队**并在 `202` 里返回 `queued` / `position`；槽位一空自动补位。审批等待会**释放槽位**（等人时不能白占），批准后再申请；排队中被「停止」的 turn 直接出队，永不执行、不泄漏槽位。
- **`ReplyOutbox`**：所有回复——包括拒绝审批、重启恢复的系统提示——只从这里写 `assistant/message`，带 `turnId` 与 `viaOutbox:true`。真正并行时才在回复上加 `taskLabel`，所以用户看到的是**一个它**在说话，能分清哪句话对应哪件事。
- **时间线**：每个 turn 写一条淡 `task` 行和**恰好一条** `task/done` 行，但**单任务时它们在界面上默认收起**（仍写进 transcript，勾「展开明细」可看），只有出现并行才整批显现——避免一句「写周报」多出两行无信息量的状态。任务编号按 Bot 持久化递增，新 Bot 的第一件事就是「任务 1」。并行时状态栏显示「并行 N 件 · 排队 M 件」，顶部「停止」变成**「停止全部 N 件」**，连排队项一起停；每个任务条另有自己的「停止」按钮可精确停某一件。完成后清掉残留进度、隐藏停止按钮，终态显示中文（完成 / 已停止 / 已拒绝 / 失败）。`MAX_CONCURRENT_TURNS=1` 可一键退回严格串行，此时不加任务标签。

`GET /api/health` 与 `GET /api/capabilities` 的 `concurrency` 给出 `maxConcurrent / active / queued / peak / started / enqueued`。真实并行的端到端验证用本地慢速 OpenAI 兼容桩服务完成：两个 `plan()` 确实重叠、后两个 turn 确实排队，全程不依赖外部网络或真实密钥。

## Thread 串联事件 + 最小链式召回

`src/threads.mjs` 的 `ThreadBook` 解决「每条事件各开一个 turn、上下文断掉」：

1. **程序侧稳定分组**：按 `botId + source + entity` 做哈希（不交给模型判断），同一线索始终落到同一个 thread；重复事件直接去重。
2. **单卡片、单 turn**：一串相关事件只在时间线写淡 `thread/event` 行（带第几条、是否续接），**只出一张** `thread-offer` 卡片；点「交给它」才把整条链合成**一个** turn。点「不用了」则丢弃链条但不派 turn。
3. **最小链式召回**：thread 用 `afterSeq` / `throughSeq` 两个 seq 水位记录「模型已经看到哪一段」。新一轮只把**增量事件**交给模型，交付完成后水位推进；不做全量历史重放。委派时会把 `throughSeq` 钉在当下，所以委派后才到的事件留给下一轮，不会被在途 turn 吞掉；卡片一旦交出就释放链位，即使那一轮被中断，后续事件也还能浮出新卡片。
4. **模型契约不破**：召回内容作为 `thread` 只放尾部 user，system 前缀保持不变；`reasoning_effort` 仍是顶层旁路字段。

接口：`POST /api/threads/ingest {botId,source,entity,text,title?,kind?}`、`GET /api/threads`、`GET /api/threads/:id`、`GET /api/threads/:id/recall?afterSeq=`。`POST /api/bots/:id/messages` 可带 `threadId`，让手工一轮也接上同一条线索。

> 这是**最小**链式召回：不做 Thread↔Worker 多对多订阅、不做 Inline & Spill、不做独立 Watchdog Session。

## 长任务可见 / 可中断 / 恢复 + 轻量 Watchdog

`src/watchdog.mjs` 只做**可见性和把决定权交回给人**，不做独立语义 Watchdog Session、不自动杀任务、不做自然语言在线改主系统。

- **可见**：`Engine.#run` 每执行一步就写一条 `progress` 事件（`step / total / summary / elapsedMs / turnId`），并把 `step`、`lastProgressAt` 等落盘。前端**就地更新**该任务条，不新增行、不刷屏；`Watchdog` 定期巡检只针对「真正开始执行过步骤」的 turn，长时间没进展时先写一条低打扰心跳。
- **可中断**：每个活跃任务条自带「停止」按钮，精确 `POST /api/turns/:id/interrupt`，不再只能停最后一个 turn。在 `model.plan()` 期间中断也不会把状态覆盖回 `running`；排队中的 turn 直接出队。
- **恢复**：中断的现场（`actions` / `index`）持久化，`POST /api/turns/:id/resume` 从那一步接着跑，**不重新规划、不重跑已完成步骤**（中断那一步按至少一次语义重做）；恢复同样受 `MAX_CONCURRENT_TURNS` 约束。进程被**强杀**后重启，`recover()` 会补上缺失的 `task/done`、把任务如实标为中断，并出一张 `resume-offer` 卡片——**绝不自动续跑**，点「接着做」才继续。
- **Watchdog 边界**：停滞只提示**一次**，出一张 `watchdog` 卡片（「停掉 / 继续等」）；它不巡检排队中或已完成的 turn，也不自己停任务。定时器 `unref()`，可 `POST /api/watchdog/tick` 手动驱动、`GET /api/watchdog` 看状态。

接口：`POST /api/turns/:id/resume`、`GET /api/watchdog`、`POST /api/watchdog/tick`。环境变量：`WATCHDOG_INTERVAL_MS`（默认 5000）、`WATCHDOG_HEARTBEAT_MS`（默认 15000）、`WATCHDOG_STALL_MS`（默认 30000）。

## P2：渠道接入 / 团队额度

**渠道**（`src/p2.mjs` 的 `ChannelBook`）：具名入站端点（webhook / slack / email），绑定一个 Bot 和可选关键词窄匹配。

- 创建时返回**一次性 token**，服务端只存 SHA-256 哈希；`GET /api/channels` 不回显 token/hash
- `POST /api/channels/:id/ingest {token, source, text}`：校验凭证 → 窄匹配 → 命中才调用 `sendMessage`；停用、撤销后立即拒绝
- 每次调用写审计（`GET /api/channels/:id/audit`）：时间、来源、是否命中、字符数、turnId、错误码；审计里不含 token
- 对应方案里「用户能审计哪些地方能指挥我的 Bot」

**团队与额度**（`TeamBook` / `QuotaBook`）：Bot 可加入团队，团队有每日 turn 额度（`0` = 不限）。额度在 `sendMessage` 接纳前检查，**渠道也不能绕过**；超限返回 entitlement 族 `USAGE_LIMIT`，标题是「用量已用完」而不是通用失败。`GET /api/quota` 看今日用量与未计量 Bot 数。

接口：`GET/POST /api/teams`、`POST /api/teams/:id/assign`、`GET /api/quota`、`GET/POST /api/channels`、`POST /api/channels/:id/toggle|ingest`、`DELETE /api/channels/:id`、`GET /api/channels/:id/audit`。工作台抽屉新增「渠道」「团队」两个页签。

## DSH 执行面（可选开关 / 灰度，默认关闭）

`@deepseek-ai/dsh@0.2.1-rc.5` 已在本机验证：`dsh headless --json` 能通过 `DEEPSEEK_BASE_URL` 接代理并返回结果。`DshExecutor` 以 **CLI 为集成边界**（隔离其 pre-stable 内部 API），命令与文件仍委托 `LocalExecutor` 保持白名单/审批边界，检索类动作走 `dsh headless`。

```powershell
$env:EXECUTOR_PROVIDER='dsh'
$env:DSH_CLI_ENTRY='<dsh 安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js'
$env:DSH_HOME='<独立的 DSH home>'
npm start
```

没装 dsh 或没设开关时一律走 local，产品闭环不受影响。本机验证：版本校验通过、`DshExecutor.browse` 返回真实模型结果、同一 Bot 会话复用成功。代理侧偶发 `RATE_LIMIT (RPM)` 属于外部限流，重试即可。

### 灰度开关与一键回退

`EXECUTOR_PROVIDER=gray` 时**默认仍是 local**，只有显式标记的 Bot 走 DSH：

```sh
curl -X POST http://127.0.0.1:3080/api/bots/<botId>/executor -H 'Content-Type: application/json' -d '{"provider":"dsh"}'
curl http://127.0.0.1:3080/api/executors                    # mode / dshAvailable / grayBots
curl -X POST http://127.0.0.1:3080/api/executors/rollback    # 一键把全部 Bot 退回 local
```

- `local`：即使 Bot 上有标记也一律走本机；`dsh`：全量走 DSH；`gray`：按 Bot 的 `executor` 字段选择，非法值被拒
- 会话表持久化在 `DATA_DIR/state/dshSessions.json`，进程重启后仍能复用同一个 DSH 会话
- 命令与文件始终委托 `LocalExecutor`，白名单/审批边界不随灰度变化

### 版本钉扎与会话复用

`DSH_PINNED_VERSION = '0.2.1-rc.5'`。每个 `DshExecutor` 实例首次调用会跑 `dsh --version` 校验，版本漂移直接报 `DSH_VERSION_MISMATCH`，不静默跑错版本。`headless --json` 的 `session` 事件带 `sessionId`，按 Bot 保存，后续调用带 `--session-id` 复用同一 DSH 会话——真实环境已验证两次调用拿到同一个 `sessionId`、第二次是 `turn:2`。

`test/dsh-contract.test.mjs` 用 fake CLI 做跟版回归（版本漂移、`final`/`sessionId` 解析、会话复用、非零退出、安全边界委托），**不需要装那 616 个包**。


## 没有做的（按 v3 的约束）

云电脑 / VNC / 每 Bot 独立屏幕 / 意图唤醒 PRETHAW / 录屏教学 / 关客户端仍执行；A2A、跨月记忆、Router/Worker 双层、Thread↔Worker 多对多订阅与完整链式召回 / Inline & Spill、**独立语义 Watchdog Session / 自然语言在线改主系统**；以及把 DSH 切成**默认**执行面（当前只是可选开关）。四条定义性能力已全部落地；运维面冻结，不再加后台页签。

## 架构与 DSH 接入点

```
web/          极简客户端（原生 HTML/CSS/JS + SSE）
src/server.mjs   HTTP + SSE 常驻进程
src/engine.mjs   turn 状态机、审批、中断、记忆
src/journal.mjs  append-only transcript + 游标 + nonce
src/store.mjs    原子写的 Bot/turn/approval/secret/artifact 状态
src/features.mjs  P1: SkillBook / RoutineScheduler / RoomHub
src/cards.mjs    类型化卡片：生成、动作分派、幂等、initiator 记录
src/p2.mjs       P2: TeamBook / QuotaBook / ChannelBook（渠道 + 额度 + 审计）
src/observer.mjs  主动观察循环：四级闸门 + observe 默认 + 去重 + 限流重排队 + 串行 drain
src/turns.mjs     并发槽位 / 排队 / 统一回复出口
src/threads.mjs   Thread 串联事件 + seq 水位增量召回
src/watchdog.mjs  轻量 Watchdog：进度心跳 / 停滞卡片 / 不自动杀任务
src/providers.mjs
  ├─ ModelProvider      MockModel | DeepSeekModel
  ├─ ExecutorProvider   LocalExecutor(默认) | DshExecutor(可选开关)
  └─ SecretBroker       值只落本机状态目录
```

**执行面是可替换 provider**，接口四个方法：`capabilities()`、`runCommand()`、`writeArtifact()`、`browse()`。`DshExecutor` 以 CLI 为边界、钉住版本并按 Bot 复用会话，只有 `EXECUTOR_PROVIDER=dsh` 才启用，**默认仍是 `LocalExecutor`**；命令与文件始终委托本机执行器，白名单/审批边界不变。

`LocalExecutor.browse()` **不再是占位**：它在 `DATA_DIR/materials/` 里做真实本机检索——文本与代码文件都认（`.md/.txt/.json/.csv/.log/.js/.ts/.py/.go/.rs/.java/.c/.cpp/.html/.css` 等，限 40 个文件、单文件 256KB、最多返回 8 条片段），**内容命中或文件名命中都算**（用户说「解释 sort.js」就能读到 `sort.js`）。命中时把片段写进 `tool/call` 并在时间线活动行显示「本机 materials/ 命中 N 处」；没资料或没命中就**如实说没有**，不编造结果。零依赖、不联网、不暴露本机绝对路径，执行面接口不变，未来换 DSH / 华为生态执行面无需改上层。

> **两阶段规划（本轮打通）**：模型给了 `write_artifact` 却没给内容时，先把本轮**真实检索到的材料**递回模型，让它写文件正文（独立的稳定 system 前缀「交付物撰写器」，材料只放尾部 user，`reasoning_effort` 仍是旁路字段）；模型还是不给，才用材料片段兜底并明确标注「模型未给出内容，系统兜底」。artifact 事件带 `composed` 标记，能分清是模型写的还是系统拼的。
>
> **生成物可执行（本轮打通）**：交付物落在 `artifacts/`，`run_command` 的 cwd 是 `DATA_DIR`。新增受控占位符 `@last`，只会展开成**本轮刚生成的那个 artifactId**（`node @last` → `node artifacts/art_xxx`），不接受任意路径；`tool/call` 记下 `resolved` 与实际 stdout。系统拼贴不再算通过——能力探针的严格判据要求 `composed=true` 且执行的正是那个生成物。
>
> **真模型实测（本轮，用你给的第三方代理 key）**：拿 `deepseek/deepseek-v4-flash` 跑同一套 14 件工作（`real_model_probe.py`），把本地桩掩盖的问题全暴露了——这是**我们链路的缺陷**，不是模型笨：
> - 模型用 `cat notes.md` 读文件 → 命令白名单没有 `cat` → 整轮 `COMMAND_NOT_ALLOWED` 失败。**修法不是放开白名单**：新增 `readCommandToBrowse`，把 `cat/type/head/tail` 这类只读命令翻译成更安全的 `browse` 路径。
> - 模型第一轮只规划动作、读完才想说，但 `reply` 在第一轮就发了 → 它只能回「我读了」。**修法**：把本机文件清单（catalog）放进尾部 user，并明确要求「先读再答，不要假装读过」。
> - 读完材料后模型仍只说「我读了」不给出内容 → 新增**重规划**：检测到空话回复且已有材料时，带材料重新规划一次再作答。
> - 模型写文件时用裸文件名（`node access.json`），而交付物在 `artifacts/` → 路径不通。除了 `@last`，新增按交付物文件名自动解析成 `artifacts/<id>`（同样只限本轮生成的文件）。
> - 模型把 `write_artifact` 排在 `browse` 之前 → 写文件时还没材料，产出空文件 → 写文件前若尚无材料，先按任务文本检索一次。
> - 代理在两阶段调用下会 `429` → 已在 adapter 里做 3 次退避重试（800ms×n），仍失败才报 `USAGE_LIMIT`。
>
> **仍存边界**：真模型输出**每轮不同**（非确定性 + 代理限流），同一批任务的通过率会波动；材料有界——query 指名文件时给全文（上限 16K 字符），只给关键词时才给 800 字符定位片段，超预算一律标 `truncated` 并说明缺什么，不编造。
>
> **观察闸门实测（本轮，量化「低打扰」）**：用产品**自己的** `JUDGE_SYSTEM` 观察哨 prompt 经真实 `deepseek/deepseek-v4-flash` 跑 27 条人工标注样本（11 条真问题 / 16 条噪音），`judge_probe.py` 报告：**误报 0、漏报 0、JSON 解析 27/27 全成功**，召回 11/11、精确 11/11、噪音正确忽略 16/16。即真实模型在我们的闸门下「该打断的一个没漏、不该打断的一个没误伤」，且弱模型最薄弱的 JSON 解析环节零失败。唯一的失败是网关 `429` 限流——已在 `observer.mjs` 加固：judge 抛 `USAGE_LIMIT` 时**把观察事件重排队而非静默丢弃**（封顶 5 次后失败闭合、不无限重排），直接补上「限流下不漏事」这条。
>
> **主动观察端到端实测（本轮，把「判断」接到「真的去干」）**：`observe_e2e_real.py` 起一个带真实 key 的常驻服务，灌一条噪音 + 一条真缺陷，走完整链路——`observation → observation-offer 卡片 → 用户点「交给它」→ 真模型 plan → 本机 browse → 统一出口回复 → task/done`。**24/24 条链路结构断言通过**：噪音被判否不出卡片、缺陷出且只出一张卡片、observe 默认不自动派 turn、delegate 后 turn 终态 `completed`、seq 严格递增、**全程只有一条 `assistant/message` 且 `viaOutbox:true`**（一个它、一个出口）、`browse` 真的读到了本机 `notes.md` 里的 `renderUser` 而不是假装读过。判据**只看链路结构，不评生成质量**。这轮还暴露并修掉一个真实并发缺陷：`#tick()` 有 `running` 互斥，但手动 `flush()` 没有，两者会**并发发起两次真模型 judge**、放大网关 429。现把批处理抽成 `#drain`，`flush()` 等待并持有同一把锁；顺带统一错误语义——单条事件失败只落 `observation/error`，不再让整批 drain 或刷新接口崩掉。
>
> **并发 turn 真模型实测（本轮）**：`conc_e2e_real.py` 让 3 个 turn **真的同时**打真实端点（`peak=3`、无排队），**17/17 条链路结构断言通过**：3 个 turn 全 `completed`、零错误事件、3 条 `user/message` / 3 条 `task` / 恰好 3 条 `task/done`（不重复闭合）、3 条回复全部 `viaOutbox:true` 且各带 `taskLabel`（一个它在说，但分得清哪句对应哪件事）、seq 19 条严格递增。原 `e2e_concurrency.py` 用慢速本地桩证明槽位/排队；这一轮补上「真模型并发调用下链路也不散」的证据。③④ 两条（Thread 分组 / 长任务 Watchdog）核心是**程序侧**的分组、水位、进度与恢复，由 stub 端到端 29+27 项覆盖，不强行用真模型凑数。
>
> **真实模型浏览器走查（本轮，回到产品感受）**：起带真实 key 的常驻服务，在浏览器里当普通用户用一遍，专门找「不像一个同事」的地方，找到并修掉四处：
> - **把「没答」伪装成「做完」**：真模型只给了 `browse`、没给 `reply` 时，`normalizeActions` 会补一句「我是 X，这一步做完了」，还连带弹「存成技能 / 每小时自动跑」卡片。现在 `reply` 缺失或空文本都标 `fallback`，兜底文案改成诚实的「还没给出答案」；`engine` 让 `fallback` 也触发**带真实材料重规划**，模型仍不答就用**本机材料原文**兜底（不编造、不打发用户）；`CardBook` 见 `fallback` 就不邀功。
> - **首屏把用户往办公助理/命令执行器引导**：提示语原来是「帮我写一份周报」「执行命令 `node --version`」，正是我们刻意避开的场景。改成「读本机材料 / 同时推进三件事」，并点出「新情况只摆一张卡片等你点头」。
> - **模型临时不可达时甩内部错误码**：时间线上原本是「Bot 没能完成这一步 / `agent/AGENT_FAILED`」。现在显示「刚才没连上模型 / 网络或模型服务临时不可用，直接再发一次就行」，错误族与 code 仍留在 journal 里但不给用户看。
> - 顺带修掉 Windows 把 `3002–3101` 划为动态端口排除段导致部分 e2e 起服务 `EACCES`（测试脚本端口挪到 3201–3203）。
>
> 走查结果：同一问题「把还没做的两件事告诉我」修复前答「这一步做完了」+ 邀功卡片；修复后真模型给出「1. 真实模型下的浏览器体验走查 2. 长任务进度文案复核」，单任务明细默认收起、时间线干净、无多余卡片。代理偶发 `fetch failed` 属外部波动，重试即可。
>
> **连续性（本轮，把「一条时间线」剩下的半件事兑现）**：之前时间线只给用户看，没给它读；技能存了不进规划、用户纠正过的话跟不到下一轮、任一步瞬时失败直接把整轮判死且 `failed` 不能续跑。现在：
> - [src/context.mjs](./src/context.mjs) 是**唯一**决定「这一轮它知道什么」的地方——从 append-only 时间线尾部有界取 12 条语义事实（用户说的、它答的、产出、成败、用户点过的决定、纠正），加上显式存过的技能（最多 8 条），一处装配、可测、不增长。不建第二套记忆、不做事实抽取，所以没有「记忆污染」这回事。[src/journal.mjs](./src/journal.mjs) 新增 `tail()` 有界尾读，避免每轮复制全量历史。
> - [src/engine.mjs](./src/engine.mjs) 把**步骤瞬时失败**和**任务死亡**分开：规划是纯的，网络抖/限流/超时退避重试 3 次；执行中的步骤不重试（命令和交付物绝不能跑两次），耗尽就**不推进 `index`**、把 turn 置为可续跑、时间线上写「刚没连上模型，停在第 N 步」并出「接着做 / 算了」卡片，人点一下从同一步续。命令被拒、审批没过这类确定性失败照旧 `failed`。
>
> 验证：`test/continuity.test.mjs` 7 项 + `e2e_continuity.py` 服务级 **18/18**（技能进入下一轮规划输入、纠正/回复/决定从时间线读回、断连不判死、卡片、接着做续跑、`tool/call` 不重复）。真实模型浏览器复验：第一轮读 `release-checklist.md` 答出两件待办并存下技能；第二轮**只说「照上次那样」**，它自己又去读清单并给出同样答案，时间线干净、无多余卡片。注：第一轮真模型只回了 `reply`、没有「有实质工作」的动作，所以没弹技能卡片，改用 `/api/skills/from-turn` 存；卡片路径由服务级桩覆盖。

## 能力探针：按模型强项逐项试

`capability_probe.py` 自己罗列 DS / harness 擅长的 14 件工作（文字 4、编程 5、推理 2、结构化 3），逐条打进产品，产出「用户可见的能力矩阵」：`capability_matrix.txt`。**刻意避开办公类**（周报 / 会议纪要 / 待办）——那不是模型强项，之前的跑批全是这类，方向不对。

首轮矩阵：文字 3/4、编程 **0/5**、推理 2/2、结构化 3/3。暴露两个真实断点：`browse` 不认 `.js/.ts/.py` 且只匹配内容不匹配文件名（用户说「解释 sort.js」查不到 `sort.js`）；模型没给交付物内容时写出空文件。修完后编程 5/5、合计 14/14 链路通。随后把 B2/B4 判据**改严**：要求交付物由模型基于材料写成（`composed=true`）、且 `node @last` 真的执行了刚生成的那个文件（stdout 含 `ARTIFACT_RAN`）——**14/14 在严判据下仍全过**。注意这指的是「链路接得住」，不是「答案对不对」；矩阵末尾列了仍存边界，不假装全通。

模型层同理：`DeepSeekModel` 已实现并通过真实模型端到端验证，支持 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`；未配置密钥时 `MockModel` 保证闭环可测。

## 安全边界（当前是原型）

- 只监听 `127.0.0.1`，**无鉴权**，不要放到公网或不可信网络
- 密钥只存在于进程环境变量，不写入代码或 `.data/`；但用第三方代理时请求会经过该服务，**贴在聊天/命令行里的密钥建议轮换**
- 本机命令只放行白名单程序（`node/git/npm/pnpm/python`），且必须经审批；`execFileSync` 不走 shell
- 敏感值不进 transcript，但值仍以明文存在 `DATA_DIR/state/secret.*.json` —— 生产需要换成 OS 凭据库 / KMS
- 单进程、单用户，没有多租户隔离、没有配额计费、没有审计导出

## 验证

```sh
npm test
```

覆盖：P0-A 全部（命名 Bot、持久 transcript、幂等/游标、审批门、中断、凭据旁路、交付物、错误族、重启恢复、中文文件名）、DSH 适配层（三态灰度、版本钉扎、会话持久化、契约测试、**真实 CLI 路径：rc.5 灰度切换 / `headless --json` 真调用 / 会话复用 / 命令仍走本机白名单 / 版本漂移 fail loudly，HARD 23/23**）、P1 后端（Skill / Routine / Room）、渐进披露卡片、P2（团队额度、渠道 token/窄匹配/审计/撤销）、**主动观察循环**（四级闸门、observe 默认、去重、模型契约：稳定前缀 / 旁路 effort / reasoning_content 兜底 / 400 降级、**限流重排队不漏事件**、**flush 与定时器串行不并发 judge**、单条失败不拖垮整批）、**并发 turn**（硬槽位、排队补位、统一出口、串行回退、中断/审批不泄漏槽位、真实重叠、**真模型并发 3 路不散**）、**自主并行拆分**（一条消息多件事 → agent 自己拆成并行子任务、父 turn 当协调者不占槽位、支数不超槽位、停父连带停子、恢复不重复拆分、空洞回复带材料重规划）、**主动回访**（悬着的事它自己回来问：等点头的审批 / 没人理的卡、每次最多一条、每 Bot 冷却、不在忙碌时插话、同一件事只提一次、模型给不出话就用程序兜底）、**Thread 串联**（程序分组、单卡片单 turn、afterSeq/throughSeq 增量召回、尾部 user 契约）、**长任务 / Watchdog**（逐步 progress、精确停止、恢复续跑、强杀重启恢复、停滞只提示一次、不自动杀任务、**步骤瞬时失败不判死、停步可续跑**）、**连续性**（时间线作为唯一上下文源、有界装配、技能与纠正/产出/结果跨轮次读回、不建第二套记忆、**按实体跨轮召回：说「package.json 那件事」能找回上次的结论、它知道自己手上有几件没做完的活**）、**交付能力**（指名长文件给全文而非 800 字符片段、截断如实标注、占位正文不算交付会触发带材料重写、跨会话「接着补」从时间线读回上次交付物正文、**写完回读校验、时间线带正文预览不用点下载、模型没答时补一句基于真实文件的交付说明**）、**真实浏览器体验走查 + 真实任务剧本跑批**（低打扰收起、停止全部含排队项、状态中文化、连续任务不堆卡片）、**真模型验收八件套**（14 件能力矩阵、27 条标注样本 0 误报/0 漏报、主动观察端到端 24 条结构断言、并发 turn 17 条结构断言、插话 8 条结构断言、自主拆分 10 条结构断言 + 5/5 拆分遵守率、主动回访 9 条结构断言、跨轮召回 7 条结构断言）、**交付验收**（换口径：不看链路结构，看交付物正文。A 小文件整理 8 条 / B 长文件整理 8 条 / C 跨会话接续 4 条内容判据，真模型 A/B/C 全 `ACCEPTED`）、**全功能联调**（`soak_all.py`：一个常驻进程串联观察定时器 / 回访定时器 / 拆分+插话 / 多任务在飞时重启+恢复 / 跨轮召回+交付，**刻意不手动 tick / scan / flush**；3 轮 HARD 链路不变量 98/98、SOFT 能力触发 22/24）、**多 Bot / 群聊 / SSE**（`multibot_accept.py`：3 个 Bot 真模型并发 `peak=3`，各自材料 / 回复 / 并行标记 / 上下文互不串味；SSE 推送 botId 正确、seq 不重不漏；RoomHub 扇出各归各时间线；HARD 30/30）、**16K+ 材料**（超预算如实标 `truncated` / `offset` 并把「缺什么就明说」透传给模型；真模型端到端明确说没看到、不猜测，对照小文件能答出）、**前端 SSE 增量 DOM**（真实浏览器不刷新下增量追加，DOM 与 API 可见条目不丢/不重/不多，跨 Bot 过滤，切 Bot 游标重置并完整重建）、**P1/P2 真模型**（Routine 定时器自驱、额度在 turn 前拦截、渠道 token / 窄匹配 / 审计 / 停用 / 撤销、Skill 进真模型规划输入；HARD 23/23）、**连续性服务级端到端 18 项**、前端（DOM 冒烟 40 项、HTTP 端到端 10 组：17+21+21+13+12+13+29+27+32+18 = 203 项）。

## 进度与验收

当前进度、验收分层、已知上限与待验证项统一见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)；验收脚本、SHA-256 清单与真模型跑法见 [acceptance/README.md](./acceptance/README.md)。
