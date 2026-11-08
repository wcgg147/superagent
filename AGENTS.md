# AGENTS.md — 常驻 Super-agent 项目规矩

> **本文件是这个项目的最高优先级约定。** 任何 agent（包括本会话与后续会话）在**开始长任务、动手改代码、或准备宣布"跑通了"之前，必须先完整读本文件**；然后读 [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md) 的定义性能力与约束段落。
> 优先级：本文件 > 项目方案文档 > `.agents/skills/` 下的任何通用工程技能 > 通用工程惯例。
> 冲突时以本文件为准，并**停下说明冲突**，不要自作主张折中。

---

## 0. 长任务开始前（强制自检）

每次开始一件事，先按顺序做完，再动手：

1. 读本文件（尤其 §2 硬约束、§3 禁改区、§5 验收规矩）。
2. 回答三个问题，答不上来就先别开工：
   - 这件事属于「一个它 + 一条时间线」里的哪一层？（见 §1）
   - 它改不改变「用户今天能不能 / 愿不愿意把一件真事交给它」？**不改变就先别做**。
   - 需要碰 §3 的禁改文件吗？**要碰就先停下**，把要改的不变量逐条写出来等用户点头。
3. 确认当前基线还绿：`npm test`（当前 **265/265**）。不绿先修，不要带着红灯往上堆功能。
4. 长任务中途若发现自己在「为了让测试变绿而放宽断言」「顺手重构底层」「换个架构更干净」——立刻停，回到 §3。
5. 收尾按 §5 分层报告，不通过不许说「跑通了」。

**常见跑偏信号**（出现即回读本文件）：开始加页签 / 加后台管理面；开始谈云端执行、GUI、VNC；开始设计第二套记忆或向量库；为了并发而复制时间线；把「模型没答好」当链路问题去改状态机；用一次单链路通过就宣布全功能可用。

---

## 1. 这个项目是什么（大方向）

**一个它 + 一条时间线**：一个常驻在**用户本机**的 AI 同事，主动观察、并行推进、连续处理，低打扰、人在回路。不是 Bot 管理后台，不是云电脑，不是聊天壳子。

四条定义性能力，已全部落地，不许推倒重来：

| | 能力 | 落点 |
| --- | --- | --- |
| ① | 主动观察循环 | `src/observer.mjs` 四级闸门；环境变了**摆卡等人点头**，不自动派 turn |
| ② | 并发 turn + 统一出口 | `src/turns.mjs` 硬槽位；所有回复经 `ReplyOutbox`；一条消息多件事由 agent 自己拆开并行 |
| ③ | Thread 串联 | `src/threads.mjs` 程序侧稳定分组 + `afterSeq/throughSeq` 水位增量召回 |
| ④ | 长任务可见 / 可中断 / 恢复 | `src/watchdog.mjs` + `Engine.resume()`；逐步 progress、精确停止、重启**不自动续跑** |

后续补强的「插话不终止 turn」「主动回访」「跨轮实体召回」「交付能力」「多 Bot 隔离」，都是在这四条之上加的，不是新主线。

**唯一判断标准**：这条会不会改变用户今天**能不能 / 愿不愿意把一件真事交给它**？不会的，先别做。

**产品方向 A 不是 B**：A = 常驻同事 + 时间线；B = 运维/控制后台。渠道、团队额度、审计、灰度、版本钉扎等控制面已冻结，**不再加新页签、不再扩控制面**。

---

## 2. 硬约束（不可协商）

- **不做云电脑 / GUI 云桌面 / VNC**。执行放用户本机常驻进程；执行面通过 `ExecutorProvider` 接口可替换，**不写死本机路径 / macOS / x86**，为未来可能的华为生态留口子，但本阶段零投入。
- **用户第三方 key 只走命令环境变量，用后即弃，绝不落盘**（不写进代码、文档、journal、store、日志）。
- **不猜未发布模型规格**。adapter 只认：结构化动作 + 稳定 system 前缀 + seq 水位 + effort 档位。
- **弱模型靠系统兜底**，不靠祈祷它自觉：占位正文检测、compose 重写、材料兜底、卡片确认、分级 effort、并行复查、两阶段规划、显式降级（降级要在时间线上说清楚，不许静默）。
- **时间线是唯一上下文源**：不建第二套记忆、不做事实抽取（故无记忆污染）；只从 append-only journal 有界取。
- **步骤瞬时失败 ≠ 任务死亡**：纯规划可退避重试；**执行中的步骤绝不重试**（命令 / 交付物不能跑两次）；耗尽则保住 `index`、置可续跑、出「接着做」卡。
- **人在回路**：有后果的命令必须审批；中断 / 重启作废待审批；恢复要人点头；观察只摆卡不自动派活。
- **低打扰**：观察四级闸门、回访每次最多一条 + 每 Bot 冷却 + 忙碌不插话 + 同一件只提一次、单任务明细默认收起、终态中文化。
- **材料有界且诚实**：query 指名文件给全文（上限 16K 字符），只给关键词才给 800 字符定位片段；超预算一律标 `truncated` / `offset`，并要求模型「缺什么就明说、不编造」。
- **不要纠结 DS 生成质量**，重点是我们链路接不接得住；不评文采，只看链路结构或交付物内容。
- **范围外 / 明确不做**：关客户端后仍执行不承诺；多对多订阅、完整链式召回、Inline & Spill、跨月长程记忆、A2A 网关；运维后台面冻结。

---

## 3. 禁改区：不准改动的底层代码

以下文件定义了产品语义，**其不变量不准改动**。要改必须先在本文件里写明「改哪条不变量、为什么、如何重新验收」并等用户点头；改完必须重跑 §5 全部基线。

| 文件 | 它保证的不变量（**全都不准破坏**） |
| --- | --- |
| `src/journal.mjs` | append-only 时间线；`seq` 从 1 严格单调递增；`read(cursor)` 增量、`tail()` 有界、`all()` 拷贝；`clientNonce` 幂等去重；`emit` 广播带 botId。**唯一上下文源**，不许在上游另建索引/摘要存储 |
| `src/store.mjs` | tmp+rename 原子写；`SAFE_ID` 校验；bot / turn / approval / secret / artifact 分离存储；secret 值与 journal 隔离 |
| `src/turns.mjs` | `TurnCoordinator` 硬槽位（默认 3）、排队补位、`cancel` 不泄漏槽位、`stats.peak`；`ReplyOutbox` 是**唯一出口**——所有 `assistant/message` 必须 `viaOutbox:true`，包括插话确认、回访、交付说明 |
| `src/context.mjs` | **唯一决定「这一轮它知道什么」的地方**：`buildTurnContext()` 有界装配 `recent` / `skills` / `related` / `openWork` / `priorDeliverables` / `interjection`；`entitiesOf()` 按文件名（含中文 `\p{L}`）召回；不建第二套记忆、不做事实抽取 |
| `src/engine.mjs` | 状态机全部接缝：`sendMessage` 只是接受；`#inFlightTurns`/`busy` 判插话且**插话不杀在跑 turn**；`#markParallel` **只统计同一 Bot** 的在飞 turn；`#runBranches` 父 turn 协调不占槽、子 turn 是真 turn、支数不超槽、停父连带停子、恢复不重复拆；`#planWithRetry` 只重试纯规划；**执行中步骤绝不重试**、耗尽不推进 `index`；`#pauseAtStep` 保现场出「接着做」；`#withdrawApproval` 中断/重启作废旧审批；`#closeTask` 保证 task / task-done 配对；`#apply` 的命令白名单翻译、占位正文检测、compose/材料兜底、写完回读 `integrity` + `preview`；`#isHollow` 空话检测；`recover()` 不自动续跑；模型没答时经统一出口补交付说明 |
| `src/providers.mjs` | 模型契约：稳定 system 前缀 + 动态上下文只放尾部 user、`response_format:json_object`、effort 旁路、400 降级、429 退避、`USAGE_LIMIT`；`parsePlan`/`normalizeActions`/`normalizeBranches`；三个稳定前缀 `JUDGE_SYSTEM`/`COMPOSE_SYSTEM`/`NUDGE_SYSTEM`；`splitIntents` 依赖护栏；`LocalExecutor` 命令白名单 `ALLOWED_BIN` 与 `READ_COMMANDS`→`browse` 翻译；`browse` 有界（16K 全文 / 800 片段 / `truncated` / `offset` / `window`）；`COMPOSE_BUDGET=16000`；**`DSH_PINNED_VERSION='0.2.1-rc.5'` + `assertPinnedVersion` 版本漂移 fail loudly，不准擅自改钉扎**；`parseDshStream`/`DshExecutor.verify()` 会话复用；`SecretBroker`/`sanitizeSecrets` 不泄露凭据 |
| `src/observer.mjs` | 四级闸门（Fast Path → low judge → observe 默认只摆卡 → auto 复查）；`#drain`/`#tick`/`flush` 串行互斥，不并发 judge；`#judgeSafe` 对 `USAGE_LIMIT` **与所有瞬时网络故障**重排队（封顶 5 次），不静默丢事件 |
| `src/nudge.mjs` | 低打扰硬门槛：每次扫描最多一条、每 Bot 冷却、忙碌不插话、同一件只提一次、悬挂物只认时间线里有事实依据的卡；话术由模型写、程序兜底（兜底取卡片摘要，不编造） |
| `src/watchdog.mjs` | 停滞**只提示一次**、出「停掉 / 继续等」卡、**绝不自动杀任务**；定时器 `unref()` |
| `src/server.mjs` | 路由契约；SSE 全局广播必须带 `botId`（前端按 botId 过滤）；artifact 下载；静态资源 |
| `src/threads.mjs` `src/cards.mjs` `src/features.mjs` `src/p2.mjs` `src/http-util.mjs` | 已被 P1/P2 真模型验收覆盖的契约：ThreadBook 分组/水位、CardBook 动作白名单、SkillBook / RoutineScheduler / RoomHub、TeamBook / QuotaBook / ChannelBook（token 只存 hash、审计不落明文）、`contentDisposition`。控制面冻结，只修 bug 不加面 |
| `test/**` 与 `package.json` 的 `test`/`check` 脚本 | **回归断言只增、不放宽、不删除**。当前基线 265 项；新增测试必须注册进脚本。为了让测试变绿而改断言 = 违规 |
| `web/app.js` 中与 `cursor` / `seen` / SSE 过滤相关的逻辑 | 切 Bot 时 `cursor`/`seen` 重置并完整重建；DOM 与 API 可见条目不丢 / 不重 / 不多；跨 Bot 推送不污染当前视图 |

### 3.1 已授权的不变量变更记录（按 §3：先写明「改哪条、为什么、如何重新验收」，再动手）

**授权依据**：分页续读前已把「材料 16K 一刀切 / 定时器长尾 / 不改代码出报告」逐条列出并经项目所有者确认；下列变更在动手前写在这里。

| 项 | 内容 |
| --- | --- |
| 改哪条不变量 | `src/providers.mjs` 的 `LocalExecutor.browse`：新增**可选分页续读**——query 写成 `文件名 @<offset>` 时从该偏移再读一页，返回增加 `page` / `nextOffset`；`planUser` 尾部 user 增加续读说明与 `nextOffset` 字段。**一律不变的**：单次 16K 全文 / 关键词 800 片段、`truncated`/`offset`/`shown`/`bytes`/`window` 语义、`COMPOSE_BUDGET=16000`、三个稳定 system 前缀、动态信息只放尾部 user、时间线唯一上下文源（每次从磁盘现读、不缓存、不建第二套索引）、执行中步骤绝不重试（续读是模型**显式新动作**，系统绝不自动翻页、绝不因 truncated 自动补读）、`ReplyOutbox` 唯一出口、`src/engine.mjs` 与 `src/context.mjs` **一行未改** |
| 为什么 | 25K 的真实文档现在只能看到前 16K；真模型实测「没看到、不猜测」是诚实，但活没干完。这直接改变用户今天愿不愿意把一件真事交给它 |
| 如何重新验收 | `npm test` 全量 + 新增 `test/browse-page.test.mjs`（分页 / 越界诚实 / 无状态不缓存 / planUser 契约 / 既有不变量守卫）注册进 `test` 与 `check`；`node --check`；密钥扫描；服务级确定性冒烟（25K 材料两页真读到 16K 之外的答案）；**§5 的 DOM 冒烟 40/40、HTTP 端到端 10 组 203 项、真模型 `trunc_accept.py` 分层 HARD/SOFT 仍须在脚本与 key 到位后重跑**，本会话不得冒充 |

> 上表是**授权当时**写下的验收计划，原文保留作为审计凭据。后续已全部实跑：DOM 40/40 + HTTP 203/203 见 `npm run acceptance`；真模型 `trunc_accept.py` HARD 5/5 + SOFT 2/2 与全套编排见 [acceptance/README.md](./acceptance/README.md)「最新实跑」。当前状态以下方「收尾状态」与 §5 为准。

**收尾状态**：确定性基线 **265/265**（`test` 与 `check` 双跑）、`npm run acceptance` **243/243**（DOM 40 项钉住断言一字未改）、`acceptance:real --list` **INTEGRITY 30/30**、jsdom 真实 SSE 渲染 8/8 + 6/6 + 6/6、真实 HTTP 200 送达、`node --check`、密钥扫描真实凭据 0 命中、端口释放。§3.4 把确定性验收脚本改成从自身位置推导路径，并在**另一个完全不同的路径**复制整个仓库实跑 **243/243**；无 key 层实跑确定性剧本 2/2 + 组合骨架 `SKELETON_VERIFIED`，真模型层仍 `NOT_VERIFIED`。当前进度、验收分层与已知上限统一见 [PROJECT_STATUS.md](./PROJECT_STATUS.md)。

**历史授权与凭据处理（摘要，完整审计见 [acceptance/README.md](./acceptance/README.md)）**：§3.1 的分页续读授权已全部实跑；5 个真模型脚本的 `read_key()` 改为只读 `DSH_TEST_KEY`，断言区字节未变（哈希记在 `manifest-real.json` 的 `sanitized`）；`conc_e2e_real.py` 的插话断言按确定性组拆法对齐后实跑 18/18；`run-real.mjs` 优先采用脚本自身 `RESULT=` 判定的 bug 已修。

**凭据与未验证项**：贴进聊天消息的旧 key 视为已泄露、须吊销/轮换，未写入项目文件、未复用。§3.3 改动后真模型全套与组合 / 定时器自驱**未重跑**，需新 key 通过命令环境变量注入；确定性 stub 只证明链路接得住，不证明真模型按新分批契约自觉产出。

**仍欠 / 上限**：连续编排时 `soak_all.py` 因延迟长尾 `BROKEN`（单独 VERIFIED）、`split_quant` 4/5 PARTIAL、`p12_accept` 1 条 SOFT MISS 如实保留；SOFT 触发率非 100%、定时器延迟长尾、材料单次有界、分批 compose 拼接可能带重复标题。不拿单轮通过冒充全绿。§5 第 3/4 步判据只看链路结构或交付物正文，不评生成质量。

**可改区补充**：`web/` 渲染与样式、提示词 / 话术文案、新增能力与测试、文档措辞与目录组织均属可改区；任何触碰 §3 表格不变量的改动必须先写清「改哪条、为什么、如何重新验收」并等用户点头。

### 3.2 已授权的不变量变更：长文档交付物不再只取最后一页

**授权依据**：真模型实跑后已把「`write_artifact` 兜底只读 `turn.lastBrowse`（最后一页），所以 25K 文档完整写成交付物仍未解决」列为待推进的真缺口并给出方向，经项目所有者确认后实施。

| 项 | 内容 |
| --- | --- |
| 改哪条不变量 | `src/engine.mjs` 的 `#apply` → `case 'write_artifact'`：材料来源由 `turn.lastBrowse?.items`（最后一次 browse）改为**从 append-only journal 读回本 turn 的所有 `tool/call` browse 结果**，按 `title+offset` 去重、按 offset 排序后交给既有 compose / 材料兜底；新增模块级纯函数 `collectTurnMaterials(entries, turnId, caps)`。**一律不变的**：`Journal` 的 append-only / seq / `read`/`tail`/`all` 语义、`ReplyOutbox` 唯一出口、`#planWithRetry` 只重试纯规划且执行中步骤绝不重试、`#forceDeliverable` / 占位检测 / 写完回读 `integrity` + `preview` / `#isHollow` / `recover()` 不自动续跑、`COMPOSE_BUDGET=16000`、单次 browse 16K / 关键词 800、`truncated` 等字段语义、系统绝不自动翻页、不建第二套记忆或缓存（每次从时间线现读）、并发按 `turnId` 隔离（不串别的 turn 的材料）、`src/context.mjs` / `src/providers.mjs` / `src/journal.mjs` **一行未改** |
| 为什么 | 上一轮为 25K 文档加了显式分页「读得到、答得出」，但用户说「把这份文档整理成文件存下来」时，兜底只拿最后一页，前半部分静默丢失。真模型实跑记录里这条被明确列为「仍未解决」的上限；它直接决定用户愿不愿意把一件真事交给它 |
| 有界且诚实 | 最多纳入 8 页、累计 64000 字符；超限即停止并给最后一项标 `truncated:true`，材料兜底正文另写一行「材料有界：还有后续页未纳入」。compose 路径仍受既有 `COMPOSE_BUDGET` 裁剪。单页场景返回值与原来等价，既有验收判据不变 |
| 如何重新验收 | `npm test` / `check` 全量 + 新增 `test/artifact-pages.test.mjs`（纯函数：多页聚合 / 按 offset 排序 / 去重 / 有界 / 只认本 turn / 空结果；引擎端到端：两页 browse 后交付物正文同时含第一页与第二页的真实答案，且统一出口、seq、task/done、integrity、零 error 不变量守住；单页回归）注册进 `test`/`check`；`npm run acceptance` 243 项；`node --check`；密钥扫描；服务级确定性冒烟（两页材料写成交付物并回读正文） |

### 3.3 已授权的不变量变更：compose 不再丢弃 16K 之后的材料页

**授权依据**：真模型全套实跑后已把「`COMPOSE_BUDGET=16000` 仍会裁剪多页材料，compose 成功路径下后半页可能落不进交付物」列为下一件，并按 §3 另行授权、经项目所有者确认后实施。

| 项 | 内容 |
| --- | --- |
| 改哪条不变量 | `src/engine.mjs` 的 `#apply` → `case 'write_artifact'`：compose 由「一次调用、全部材料」改为**按既有 `COMPOSE_BUDGET` 分批调用再按序拼接**；新增模块级纯函数 `splitMaterialsForCompose(items, budget)`；artifact 事件新增 `composeBatches`（仅分批 >1 时出现）与 `composeDegraded`（降级时出现）两个诊断字段。**一律不变的**：`COMPOSE_BUDGET=16000` 的值与 `composeUser` 的裁剪逻辑（`src/providers.mjs` **一行未改**）、三个稳定 system 前缀与「动态信息只放尾部 user」、`collectTurnMaterials` 的 8 页 / 64000 字符上限与 `truncated` 语义、时间线唯一上下文源（材料仍从 append-only journal 现读、不缓存）、系统绝不自动翻页、`ReplyOutbox` 唯一出口、`#planWithRetry` 只重试纯规划且**执行中步骤绝不重试**（分批是不同材料页的显式多次生成，不是同一动作重试；任一批失败是整体降级，绝不重试同一批）、占位检测 / 写完回读 `integrity` + `preview` / `#isHollow` / `recover()` 不自动续跑、`src/context.mjs` / `src/journal.mjs` / `src/turns.mjs` **一行未改** |
| 为什么 | §3.2 让长文档「读得到、答得出、材料兜底写得出全文」，但用户说「把这份文档整理成文件」且模型走 compose 成功路径时，`composeUser` 在累计 16000 字处 `break`，第二页整页静默丢失 —— 交付物看起来成功却缺一半内容。这直接决定用户愿不愿意把一件真事交给它 |
| 有界且诚实 | 每批累计材料 ≤ `COMPOSE_BUDGET`（16000），批数受 `collectTurnMaterials` 的 8 页上限约束（≤8 次调用）；分批时时间线 artifact 事件带 `composeBatches` 明示，不静默。任一批返回空或抛错 → **不拼接半截**，整体降级到既有材料兜底（正文仍含全部已读页）并标 `composeDegraded:true`。单批场景与原来完全等价，既有验收判据不变 |
| 如何重新验收 | `npm test` / `check` 全量 + 新增 `test/compose-batches.test.mjs`（纯函数：不切 / 分批 / 每批 ≤ 预算 / 顺序 / 空输入 / 超长单页保底一批；引擎端到端：两页 25K 材料走 compose 后交付物同时含两页真实答案且 compose 每批材料 ≤16000、分批字段出现、任一批失败降级到全文兜底、单页回归只调用一次；统一出口 / seq / task-done / integrity / 零 error 不变量守卫）注册进 `test`/`check`；`npm run acceptance` 243 项；`node --check`；密钥扫描；服务级确定性冒烟（真实 HTTP 进程分段 compose 后下载正文含两页答案） |

### 3.4 开源可移植性变更：确定性验收脚本不再硬编码开发机路径

**授权依据**：项目所有者在开源整理时要求「把前面说的几个问题都解决」，其中一条是验收脚本在别的机器上无法直接运行；下列变更在动手前写在这里。

| 项 | 内容 |
| --- | --- |
| 改哪条不变量 | `acceptance/e2e/*.py`（11 个）与 `acceptance/ui-smoke/run.mjs` 顶部的路径常量：`BASE` / `WORKSPACE` / `SCRATCH` fallback / `WEB` / 两处 `file:///C:/...` import，改为**从脚本自身位置推导**（`os.path.dirname(__file__)` / `new URL(..., import.meta.url)`）。`acceptance/run.mjs` 的完整性校验由「硬编码路径必须等于当前工作区」改为**更严格**的「任何钉住脚本都不得含开发机绝对路径」；`manifest.json` 的 13 个 SHA-256 随文件重生成。**一律不变的**：所有 `check(...)` 断言、端口、判据、报告格式、`SUMMARY:` 行、10 组 203 项与 DOM 40 项的数量与内容；`test/**` 与 `package.json` 的 `test`/`check` 脚本**一行未改**；`src/**` **一行未改**；`acceptance/real/*.py` 与 `manifest-real.json` **一行未改**（其断言区哈希被 `test/acceptance-guard.test.mjs` 钉住，改动会破坏「脱敏版只改了 `read_key()`」的审计证据，故真模型层仍按 [acceptance/README.md](./acceptance/README.md) 迁移）。 |
| 为什么 | 仓库克隆到任意路径后，`npm run acceptance` 原先会因 `INTEGRITY_FAIL` 直接退出，或静默测到别的目录；这直接决定开源后别人能不能复现 §5 第 2 步的 243 项。 |
| 如何重新验收 | 改动前把 13 个钉住文件备份到会话 scratch；用「移除被改的路径行后逐字节比对」证明断言区与旧版完全相同；重生成 `manifest.json`；实跑 `npm test` / `check` 265/265、`npm run acceptance` **HTTP 203/203 + DOM 40/40 = 243/243**、`acceptance:real --list` INTEGRITY 30/30、`node --check`、密钥扫描、端口释放。 |

### 可改区（相对自由）

- 提示词 / 话术文案（但保持「稳定 system 前缀、动态信息放尾部 user」这条契约）
- `web/` 的渲染与样式（除上表游标逻辑）
- 新增能力（先过 §1 判断标准）、新增测试、文档
- 文档措辞与目录组织（不改任何断言、钉住脚本或禁改区逻辑）
- `.agents/skills/` 下两个技能库的**索引文件**（原始技能文件不要改写）

---

## 4. 环境与运行

- 零依赖 Node ESM，Node >= 20；启动 `node src/server.mjs` / `npm start`。
- 端口：3080 常被 Windows 动态端口排除段保留（`EACCES`）；**预览用 3211**，e2e 用 3201–3203 / 3213–3219。
- `DATA_DIR/materials/` 放用户材料；`DATA_DIR/state/` 是持久化状态，`artifacts/` 是交付物。
- 模型 key 仅通过环境变量注入（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`），不落盘。
- 灰度执行面用 `EXECUTOR_PROVIDER=gray` + `DSH_CLI_ENTRY` 指向 CLI（不写死本机路径）；钉扎版本不符按设计拒绝。
- 运行中的 server **不热更新**，改源码后必须杀掉重启才能验收新行为。
- 验收套件 `npm run acceptance` 额外需要 Python 3 标准库与 `acceptance/ui-smoke/node_modules/jsdom`（仅验收期依赖，被 `.gitignore` 忽略）；`npm start` / `src/` 运行时仍是零依赖 Node ESM。
- `npm run acceptance:real` 是 §5 第 3/4 步入口，需要 `DSH_TEST_KEY` 或 `DEEPSEEK_API_KEY`（只走命令环境变量）；无 key 时明确 `NOT_VERIFIED`，不冒充通过。详见 [acceptance/README.md](./acceptance/README.md)。

---

## 5. 验收规矩（改完必做，不许跳过）

1. `npm test`（当前 **265/265**）——确定性 stub 基线。
2. 前端 / HTTP 回归：DOM 冒烟 **40/40**、HTTP 端到端 **10 组 203 项** —— 跑 `npm run acceptance`（项目内 `acceptance/`，原始脚本 + SHA-256 清单，见 [acceptance/README.md](./acceptance/README.md)）。**不再依赖临时 scratch**。
3. 真模型验收：**判据只看链路结构或交付物正文，不评生成质量**；分层报告 `HARD`（链路不变量）/ `SOFT`（能力触发率），并如实记录延迟与 MISS。
4. **不许用一次单链路通过宣布全功能跑通**；组合、重启、定时器自驱都验过才算。三个常驻循环（观察 / 回访 / Watchdog）必须让**定时器自己跑**，不许只用手动 `flush()` / `scan()` / `tick()` 冒充。
5. 收尾检查：`node --check` 改过的文件、密钥扫描 0 命中、文档计数同步。
6. 报告里必须写清「仍有上限 / 仍未验证」的部分；不拿「正确拒绝」冒充「跑通」。

### 当前已验证到的边界

全功能联调 HARD 98/98、多 Bot/群聊/SSE HARD 30/30、截断诚实性 HARD 5/5、P1/P2 HARD 23/23、the agent harness 真实 CLI HARD 23/23。
**仍存在的不是坏、是上限**：能力触发率不是 100%（自主并行在代理限流下显式降级）、定时器延迟有长尾（观察 4.1–22.5s、事件→主动开口 8.3–28.1s）、材料有界。

---

## 6. 项目内两个技能库（按需读，不要一次灌进上下文）

| 路径 | 用途 |
|---|---|
| [.agents/skills/addyosmani-agent-skills/SKILL.md](./.agents/skills/addyosmani-agent-skills/SKILL.md) | Addy Osmani 的 25 个生产级工程技能（规划拆解、规格驱动、评审、调试、TDD、上下文工程…），MIT，原始文件在 `skills/<name>/` |
| [.agents/skills/lauren-tan-pstack/SKILL.md](./.agents/skills/lauren-tan-pstack/SKILL.md) | Lauren Tan 的 pstack（Codex 移植版）63 个 SKILL.md + playbooks，长任务防跑偏 / 追问前提 / 改动影响面 / 证据驱动，MIT，原始文件在 `plugin/skills/<name>/` |

用法：长任务前先读本文件 → 判断阶段 → **只读需要的那一个**具体技能 → 与本文件冲突时以本文件为准。
这两个库是开发期资料，与产品运行、测试、验收无关系；按项目所有者要求保留在仓库内，随仓库发布时保留各自的 `LICENSE`、`UPSTREAM-README.md` 与 `plugin/UPSTREAM.md` 中的出处。**开源整理时曾误删、已完整恢复：698/698 文件逐字节一致**（694 个上游原始文件、2 个 `UPSTREAM-README.md` 按原始安装命令从上游 README 复制、2 个 `SKILL.md` 从会话日志还原并与创建时 `afterHash` 校验），0 缺失、0 不一致。

明确不照搬：git worktree / PR 队列 / 多机编排 / 自动落主干 / 「never block on the human」（本项目必须人在回路）。

本文件与 [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md) 是唯一工程约定来源；长任务前先读本文件 → 回答 §0 三问 → 再动手，与本文件冲突时以本文件为准。


---

## 7. 一句话记住

**改任何东西之前先问：这会不会动到那条时间线、那个统一出口、那些已验过的不变量？会，就先别动。**
