# 项目内验收套件（§5 第 2 步）

以前这一层依赖临时 scratch 里的脚本，会话一换就没了，导致每次收尾都得写「DOM 冒烟 40/40、HTTP 端到端 10 组 203 项未重跑」。现在把**原始脚本**搬进项目，断言一字未改，并加了一条 SHA-256 完整性闸门。

## 跑法

```sh
npm run acceptance
# 等价：node acceptance/run.mjs
```

输出分五段：`INTEGRITY` → 10 组 HTTP → `HTTP TOTAL` → DOM → `ACCEPTANCE=PASS`。任一失败退出码非 0。

## 覆盖

| 层 | 脚本 | 项数 |
|---|---|---|
| HTTP 端到端 | `e2e/e2e.py` | 17 |
| | `e2e/e2e_cards.py` | 13 |
| | `e2e/e2e_concurrency.py` | 32 |
| | `e2e/e2e_continuity.py` | 18 |
| | `e2e/e2e_executor.py` | 12 |
| | `e2e/e2e_observer.py` | 13 |
| | `e2e/e2e_p1.py` | 21 |
| | `e2e/e2e_p2.py` | 21 |
| | `e2e/e2e_threads.py` | 29 |
| | `e2e/e2e_watchdog.py` | 27 |
| | **小计** | **203** |
| DOM 冒烟（jsdom） | `ui-smoke/run.mjs` | **40** |
| | **合计** | **243** |

这 203 项就是 [AGENTS.md](../AGENTS.md) §5 第 2 条写的「10 组 203 项」，40 项是「DOM 冒烟 40/40」。与 `npm test` 的 265 项**是两层不同的东西**：后者是确定性 stub 单测，前者起真实 HTTP 常驻进程 / 真实 DOM 运行时。

## 不变量保护

`manifest.json` 冻结了 11 个 `e2e*.py`（含 `e2e_real.py`）、`ui-smoke/run.mjs`、`ui-smoke/package.json` 的 SHA-256。`run.mjs` 在跑任何测试**之前**逐个校验：文件被改过就直接 `INTEGRITY_FAIL`，并提示「断言变更必须先走 AGENTS.md §3」。这样「为了让测试变绿而放宽断言」不会再静默发生。

**确定性层已零配置可移植**（[AGENTS.md](../AGENTS.md) §3.4）：11 个 `e2e*.py` 与 `ui-smoke/run.mjs` 的 `BASE` / `WORKSPACE` / `SCRATCH` / `WEB` 改为从脚本自身位置推导，`manifest.json` 的 13 个 SHA-256 随之重生成；`run.mjs` 的完整性校验改为**更严格**的「任何钉住脚本都不得含开发机绝对路径」。改动前把 13 个文件备份，用「移除路径行后逐字节比对」证明 **12/12 文件的断言、端口、判据、报告格式完全未变**；已把整个仓库复制到另一个完全不同的路径实跑 **HTTP 203/203 + DOM 40/40 = 243/243**，克隆到任意目录都不需要迁移。

**真模型层（§5 第 3/4 步）仍带开发机路径**：`acceptance/real/*.py` 与 `manifest-real.json` 未改——后者的 `sanitized` 段用断言区哈希证明「脱敏版只改过 `read_key()`」，被 `test/acceptance-guard.test.mjs`（禁改区）钉住，改动会破坏这条审计证据。该层本来就需要第三方 key、外部 DSH CLI 与 3211 服务；在有 key 的机器上按 [AGENTS.md](../AGENTS.md) §3 记录后，替换脚本顶部 `WORKSPACE` / `ROOT` 常量并重新生成 `manifest-real.json` 即可。不要顺手改 `check(...)`。

## 依赖

- **运行时仍是零依赖 Node ESM**。`acceptance/` 不参与 `npm start`。
- HTTP 10 组：只需 Python 3 标准库（`PATH` 里的 `python`，可用 `PYTHON=...` 覆盖）和 Node。
- DOM 冒烟：需要 `jsdom`（`ui-smoke/package.json` 声明 `^29.1.1`）。本工作区已附一份 `ui-smoke/node_modules`，被根 `.gitignore` 的 `node_modules/` 忽略；若被清理，用 `npm install --prefix acceptance/ui-smoke` 恢复，不需要联网改产品代码。
- 端口：历史脚本用 3102–3109 / 3201–3203 / 3212–3213，顺序执行不冲突；如与本机服务撞端口，驱动会报出对应组的失败明细。

## 明确不在这里（不要冒充）

- `e2e/e2e_real.py` 已归档但**不在默认 10 组里**：它需要第三方模型 key，没有 key 时 `real model selected (not mock)` 必失败。真模型验收属 §5 第 3 条，须单独注入环境变量跑，key 用后即弃、绝不落盘。
- 真模型分层 `HARD`/`SOFT`、`soak_all.py` 的三个常驻循环定时器自驱、组合 / 重启 / 多 Bot 真实并发：`run.mjs` 结尾会打印 NOT RUN 清单。通过本套件**不等于**「全功能跑通」。
- 本套件是确定性回归，不评生成质量。

---

## 真模型 / 组合验收（§5 第 3、4 步）

```sh
npm run acceptance:real -- --list   # 只列清单 + 完整性/依赖状态，不跑任何东西
npm run acceptance:real             # 无 key：跑 2 个确定性剧本，真模型部分 NOT_VERIFIED

# 有 key：必须同时给代理地址与模型名（都不是凭据，可写进命令）
$env:DSH_TEST_KEY='<只在这次命令里>'
$env:DEEPSEEK_API_KEY=$env:DSH_TEST_KEY
$env:DEEPSEEK_BASE_URL='https://api.qnaigc.com/v1'
$env:DEEPSEEK_MODEL='deepseek/deepseek-v4-flash'
$env:DSH_TEST_BASE='https://api.qnaigc.com/v1'
$env:DSH_TEST_MODEL='deepseek/deepseek-v4-flash'
npm run acceptance:real
```

> **只给 key 会 `NO_CREDENTIAL`**：`e2e/e2e_real.py` 起服务时**不写死**代理地址和模型名，靠外部注入；只给 key 时服务拿默认端点去校验这个代理 key，必然失败。驱动在有 key 但缺这四个变量时会打印 `HINT missing ...`。这些是地址/模型名，不是凭据；key 本身仍然只走命令 env、不落盘。

**它和 `npm run acceptance` 是两层**：后者 243 项是确定性闸门，永远不需要 key；前者需要第三方 key，**不在** `npm test` / `check` 里。

### 已固化（17 个：11 逐字节原始 + 5 脱敏 + 1 断言同步，`manifest-real.json` 守护）

| 类别 | 脚本 | 说明 |
|---|---|---|
| 确定性（无需 key） | `real/capability_probe.py` | 14 件工作能力探针，本地 stub 模型 |
| | `real/task_battery.py` | 真实任务剧本跑批，导出用户可见时间线 |
| 真模型·自包含 | `e2e/e2e_real.py`（在主清单） | 单链路 11 项 |
| | `real/observe_e2e_real.py` | 主动观察端到端 24 条结构断言 |
| | `real/conc_e2e_real.py` | 并发 turn 真模型（现 18 条；**断言同步版**，见下方） |
| | `real/judge_probe.py` | 观察哨 27 条标注样本，直接打 API |
| | `real/real_model_probe.py` | 14 件能力矩阵，直接打 API |
| | `real/dsh_real_accept.py` | DSH 真实 CLI HARD 23/23（还需外部 rc.5 CLI） |
| 真模型·需先起 3211 服务 | `real/delivery_accept.py`、`real/entity_accept.py`、`real/interject_accept.py`、`real/split_accept.py`、`real/split_quant.py` | 组合链路，驱动默认不自动起服务，会打印准确的手动步骤 |
| 脱敏版·有 key 才跑 | `real/trunc_accept.py`、`real/soak_all.py`、`real/multibot_accept.py`、`real/p12_accept.py`、`real/nudge_accept.py` | 仅 `read_key()` 改为只读 env；断言区与原始逐字一致，详见下方「5 个脱敏版」。`soak_all.py` 覆盖 §5 step 4 定时器自驱 |

判据沿用脚本自己的 `RESULT=` / `SUMMARY:` / `HARD` / `SOFT` 标记，驱动**原样打印**、不擅自合并或放宽；不评生成质量。无 key 时会实跑 2 个确定性剧本并打印 `REAL_ACCEPTANCE=NOT_VERIFIED` —— **这不是通过**。有 key 时跑完自包含组（含 5 个脱敏版与 `soak_all.py`）后打印 `REAL_ACCEPTANCE=PARTIAL`，因为依附 3211 的手工组合链路仍未验。

### key 的处理（对齐 AGENTS.md §2）

驱动把 `DSH_TEST_KEY` 或 `DEEPSEEK_API_KEY` 的值**同时**注入两个变量到子进程 env，覆盖历史脚本的两种命名；**不打印值、不写任何文件、不传进任何报告**。`test/acceptance-guard.test.mjs` 把这几条变成了回归断言。key 用后即弃。

脚本里硬编码的代理地址 `https://api.qnaigc.com/v1` 与模型名沿用历史原文（不是凭据）。若要换代理，可给命令加 `DSH_TEST_BASE` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`；**自包含脚本内部仍会写死原值**，需要改脚本时按 AGENTS.md §3 记录并重生成 `manifest-real.json`，不要顺手改 `check(...)`。

### 5 个脱敏版：凭据冲突已按授权消解

`trunc_accept.py`、`soak_all.py`、`multibot_accept.py`、`p12_accept.py`、`nudge_accept.py` 的历史 `read_key()` **从会话日志 `.jsonl` 用正则抠 `sk-...` 密钥**，与 [AGENTS.md](../AGENTS.md) §2「key 只走命令环境变量、绝不落盘」冲突。按规矩先停下说明、不折中；方案写进文档并经项目所有者确认后按授权收编。

**改动范围仅 `read_key()` 函数体**：

```python
def read_key():
    return os.environ.get("DSH_TEST_KEY", "").strip() or None
```

其余字节（`check(...)` 断言、端口、报告写出、模型设置、import）**一个都没动**。证明：把新旧两版的 `read_key()` 都替换成固定标记后算 SHA-256，5 个文件的「断言区哈希」逐一与原始相同；哈希记在 `manifest-real.json` 的 `sanitized.files.*.assertionsSha256` / `originalAssertionsSha256`，由 `test/acceptance-guard.test.mjs` 逐个复算，还断言项目内文件的 sha256 **不等于**违规原版的 sha256。所以这些**不是逐字节原始**，文档与驱动都如实标注 `SANITIZED`，不许冒充。

这 5 个现已接入 `run-real.mjs` 的 `SELF_CONTAINED`（有 key 才跑）：截断诚实性 HARD/SOFT、多 Bot/群聊/SSE、P1/P2、主动回访，以及 `soak_all.py`（标注 `timers: true`）—— 后者就是 §5 第 4 条要求的「三个常驻循环让定时器自己跑」。

> 安全提醒（非项目改动，我不会去碰）：那个历史会话日志 `.jsonl` 若真含明文密钥，建议由你自行检查清理；**贴进聊天消息的 key 同样视为已泄露，用完请吊销/轮换**。

### 组合脚本（依附 3211 服务）的前置条件

驱动默认不自动起这个服务。跑之前要：① 用同一条命令注入 key + 四个地址/模型变量，起 `node src/server.mjs`（`PORT=3211`）；② 在 `DATA_DIR/materials/` 放三份夹具：`项目现状.md`、`项目现状_长.md`（待办在 800 字符之后）、`package.json`（声明 npm scripts）。**空 DATA_DIR 会让 `delivery_accept.py` 报「没有读到可用材料」、`entity_accept.py` 召回不到脚本名**，那是前置缺失，不是产品缺陷。材料只放临时数据目录，不写进项目。然后按驱动打印的顺序执行 5 个脚本。

### 实跑记录（一次有 key 的完整验收，2026-11-07）

注入方式：key 只在这次命令的进程 env 里，跑完即弃；未写进任何项目文件。

| 层 | 结果 |
|---|---|
| `npm test` / `check` | 195/195 |
| `npm run acceptance` | HTTP 203/203 + DOM 40/40 = 243/243 |
| 有 key 编排 11 组 | **9/11 干净通过**：`e2e_real` 11/11、`observe_e2e_real` 24/24、`judge_probe` / `real_model_probe` / `nudge_accept` 通过、`dsh_real_accept` HARD 23/23 + SOFT 2/2 VERIFIED、`trunc_accept` HARD 5/5 + SOFT 2/2 VERIFIED、`multibot_accept` HARD 30/30 VERIFIED、`p12_accept` HARD 23/23 VERIFIED（1 条已知 SOFT MISS：该脚本自身是 local 模式，不做真实 CLI 调用）、`soak_all` 三个常驻循环定时器自驱 VERIFIED |
| 组合 5 脚本 | 补齐全材料后 **5/5**：交付 A/B/C 全 ACCEPTED、实体召回 6/6 ACCEPTED、插话 8/8、拆分 10/10、拆分遵守率 5/5 STABLE |

**两个未清的 FAIL，性质都已定位，不是产品链路破坏**：

1. `real/conc_e2e_real.py` 当时 15/17 —— **历史断言过期**。产品后来新增「插话不终止 turn」，3 个并发 turn 里后两条被判插话，各多一条插话确认气泡：5 条 `assistant/message`、其中 2 条不带 `taskLabel`。确定性组 `e2e_concurrency.py` 早期已把 `all_replies` 拆成 `replies` / `acks` 分别断言，真模型组第 143–151 行没同步。该组 HARD 全过（统一出口 5/5、seq 严格递增、task/done 配对、零 error、3 turn 全 completed）。**已在后续一轮按用户点头对齐**：统一出口检查仍覆盖全部回复、新增一条 acks 断言，真模型单次实跑 **18/18 全过**。详见下方「断言同步版」。
2. `real/soak_all.py` 三轮中一轮 `BROKEN` —— `s3_split_interject: TimeoutError: turn not terminal`，真模型延迟长尾导致场景窗口超时；另两轮 `RESULT=VERIFIED`（观察 4.6s、主动消息 10.3s、Watchdog ticks 136/145/179、槽位归零）。这就是文档记载的「能力触发率不是 100%」，不是「一次单链路通过宣布全功能跑通」。

### 仍未验证 / 上限（不拿上面的通过冒充）

- `conc_e2e_real.py` 的 2 条过期断言已修并实跑 18/18；`soak_all.py` 三轮中一轮 `BROKEN` 仍是真模型延迟长尾，未冒充全绿。
- SOFT 触发率非 100%、定时器延迟长尾、材料单次有界 —— 产品上限不变；「`write_artifact` 兜底只读最后一页」**已在 [AGENTS.md](../AGENTS.md) §3.2 修掉**（从时间线读回本 turn 全部 browse 页），「compose 成功路径被 `COMPOSE_BUDGET=16000` 裁掉后半页」**已在 §3.3 修掉**（按同一预算分批 compose，不抬高预算、不改 `providers.mjs`）。
- 真模型输出非确定性：同一脚本两轮可能一条 SOFT MISS 一条 SOFT PASS（`trunc_accept` 出现过），按 §5 只看链路结构或交付物正文，不评生成质量。
- 有 key 全套编排已在最新一轮实跑（见下节）；**该 key 已两次贴进聊天消息，视为已泄露，务必吊销/轮换**，后续请用新 key。

### 断言同步版（1 个，不冒充逐字节原始）

`real/conc_e2e_real.py` 的历史断言随产品行为变化过期；用户点头后按确定性组 `acceptance/e2e/e2e_concurrency.py` 第 166–178 行的 `replies`/`acks` 拆法对齐了第 143–151 行：**统一出口检查仍覆盖全部回复**（没有放宽），并**新增**一条「插话确认也走统一出口」断言。`manifest-real.json` 的 `synced` 段单独记录新旧 sha256 与变更行，驱动打印 `SYNCED 1`。这 1 个**不得称为逐字节原始**。真模型单次实跑 `SUMMARY: 18/18 passed`（acks=2）。

### 本轮产品能力改动与确定性实跑（2026-11-07 续）

`src/engine.mjs` 的 `write_artifact` 材料兜底原先只读 `turn.lastBrowse`（最后一次 browse），长文档分页后前半部分静默丢失。现改为从 append-only journal 读回**本 turn 的所有 `tool/call` browse 结果**（纯函数 `collectTurnMaterials`，按 `title+offset` 去重、按 offset 排序、最多 8 页 / 64000 字符、超限标 `truncated` 并在正文写「材料有界」），不建任何缓存或第二套记忆；`context.mjs` / `providers.mjs` / `journal.mjs` 一行未改。授权与不变量清单见 [AGENTS.md](../AGENTS.md) §3.2。

| 层 | 结果 |
|---|---|
| `npm test` / `check` | **205/205**（新增 `test/artifact-pages.test.mjs` 9 项；`test/acceptance-guard.test.mjs` 增至 11 项） |
| `npm run acceptance` | HTTP 203/203 + DOM 40/40 = **243/243** |
| `--list` / 无 key 模式 | **30/30** 完整性；确定性剧本 2/2 PASS + `REAL_ACCEPTANCE=NOT_VERIFIED` |
| 服务级确定性冒烟 | **8/8**（真实 HTTP 进程：两页 browse → 下载交付物 → 正文同时含两页真实答案、磁盘与下载逐字一致、`integrity=true`、统一出口、零 error）+ **9/9**（分页续读冒烟） |
| `node --check` / 密钥扫描 / 进程 | 全过；780 文件真实凭据 0 命中、日志抠 key 模式 0 命中；无持久变量、无遗留监听 |

**有 key 全套编排已在最新一轮实跑**（见下节），本轮不再列为「未跑」；连续编排受代理瞬断长尾影响，结论按分层如实记录。

### 最新实跑：全套真模型复跑（当前代码，含长文档交付改动）

注入方式：key 只在这次命令的进程 env 里，跑完即弃；输出脱敏；未写进任何项目文件。**该 key 已第二次贴进聊天消息，视为已泄露，跑完请立即吊销/轮换。**

| 层 | 结果 |
|---|---|
| `npm test` / `check` | **205/205** |
| `npm run acceptance` | HTTP 203/203 + DOM 40/40 = **243/243** |
| 连续有 key 编排 11 组 | **7/11 干净通过**：`e2e_real` 11/11、`observe_e2e_real` 24/24、`conc_e2e_real` **18/18**（修复后）、`judge_probe` / `real_model_probe` / `nudge_accept` / `multibot_accept`(VERIFIED) 通过 |
| 4 个 FAIL 组 | `dsh_real_accept`、`trunc_accept`、`p12_accept`、`soak_all` —— 落盘时间线显示中后段大面积 `NO_CREDENTIAL`（代理瞬断/限流长尾），`soak_all` 观察延迟 **91.8s**（上轮 4.6s） |
| **单独重跑 4 组** | **全部恢复**：`trunc_accept` HARD 5/5 + SOFT 2/2 VERIFIED；`dsh_real_accept` HARD 23/23 + SOFT 2/2 VERIFIED；`p12_accept` HARD 23/23 + SOFT 1/2 VERIFIED（1 条已知 SOFT MISS：脚本自身 local 模式）；`soak_all` **VERIFIED**（观察 2.0s、回访 6.2s、Watchdog ticks 141、槽位归零，三个常驻循环定时器自驱） |
| 组合 5 脚本（3211） | `delivery_accept` ACCEPTED、`interject_accept` ACCEPTED、`split_accept` ACCEPTED、`entity_accept` 首次 3 FAIL / **单独 6/6 ACCEPTED**、`split_quant` **4/5 PARTIAL**（SOFT 触发率） |

**诊断依据（不是猜）**：直接探测同一代理返回 `HTTP 200 / choices-ok`（key 有效）；失败组的时间线错误集中在 `NO_CREDENTIAL`（[providers.mjs](../src/providers.mjs):355，上游 401/402 类响应归类），且按时间顺序从连续跑的中后段开始出现；`dsh_real_accept` 的 S1 是另一个独立现象（`AGENT_FAILED: DSH 退出码 null`，CLI 进程，不打真模型）。**HARD 链路不变量没有一处被破坏**，确定性全套与服务级冒烟全绿。

**不冒充**：连续编排不是 11/11 全绿，如实记为 7/11 + 4 组单独 VERIFIED；`split_quant` 4/5 PARTIAL 与 `p12_accept` 1 条 SOFT MISS 都保留。按 §5，不拿单独通过宣布「全功能跑通」。

### 分段 compose 的确定性实跑（§3.3，当前代码）

`src/engine.mjs` 的 `write_artifact` 现在按**既有 `COMPOSE_BUDGET=16000`** 把材料分批喂给 compose 并按序拼接；`src/providers.mjs` 一行未改（预算值、`composeUser` 裁剪、稳定 system 前缀都不动）。artifact 事件新增 `composeBatches`（分批 >1 时）与 `composeDegraded`（任一批失败、整体降级到全文材料兜底时）。授权与不变量清单见 [AGENTS.md](../AGENTS.md) §3.3。

| 层 | 结果 |
|---|---|
| `npm test` / `check` | **217/217**（新增 `test/compose-batches.test.mjs` 10 项；`test/artifact-pages.test.mjs` 的 compose 断言按新契约对齐并加严；`test/acceptance-guard.test.mjs` 增至 13 项） |
| `npm run acceptance` | HTTP 203/203 + DOM 40/40 = **243/243** |
| `--list` / 无 key 模式 | **30/30** 完整性；确定性剧本 2/2 PASS + `REAL_ACCEPTANCE=NOT_VERIFIED` |
| 服务级冒烟 | **9/9**（真实 HTTP 进程：两页 browse → 分段 compose → 下载正文含两页答案、`composeBatches=2`、`integrity=true`、**每批材料 16000+5074 均 ≤16000**、统一出口、零 error、磁盘与下载逐字一致）+ **8/8**（材料兜底）+ **9/9**（分页续读） |
| 降级路径 | 任一批返回空 / 抛错 → 不拼接半截，整体降级到全文材料兜底，正文仍含两页，标 `composeDegraded:true`；失败的批次**不重试** |
| 单页回归 | 只调用一次 compose，artifact 不带新字段，与原实现等价 |

**真模型未重跑**：旧 key 已贴进聊天两次、视为已泄露须吊销/轮换，当前无新 key；确定性 stub 只证明链路接得住，不证明真模型按新分批契约自觉产出。按 §5，不拿确定性单测通过冒充真模型验收。

### 组合验收入口：`npm run acceptance:composition`

依附 3211 的 5 个脚本（`delivery_accept.py` / `entity_accept.py` / `interject_accept.py` / `split_accept.py` / `split_quant.py`）都**硬编码** `http://127.0.0.1:3211` 且被 `manifest-real.json` 的 SHA-256 钉住，不能改地址。以前跑它们要手工：起常驻服务 → 在 `DATA_DIR/materials/` 预置三份夹具 → 按序跑 5 条命令 → 停服务。现在 [run-composition.mjs](./run-composition.mjs) 把这一整套固化：

```sh
npm run acceptance:composition -- --list   # 只打印计划，不起服务
npm run acceptance:composition             # 无 key：骨架自检 + COMPOSITION=NOT_VERIFIED
npm run acceptance:composition -- --mock   # MockModel 实跑 5 脚本，只证明编排
$env:DSH_TEST_KEY='<新 key>'; npm run acceptance:composition   # 有 key：真模型跑 5 脚本
```

- 启动前先探测 3211 是否空闲；**占用则明确报错退出，绝不杀已有服务**（人在回路）。
- 服务与三份夹具都放在一次性 `mkdtemp` 的 `DATA_DIR`，跑完 `child.kill()` + 等端口释放 + 清理目录；不写进项目。
- 逐个校验 5 个脚本的 SHA-256 与硬编码地址，任何改动都 `INTEGRITY_FAIL`，逼着走 AGENTS.md §3。
- key 只注入子进程 env，输出统一脱敏；**无 key 时打印 `NOT_VERIFIED`，不冒充通过**；`--mock` 打印 `SKELETON_VERIFIED`，明确「脚本判据不算模型结论」。
- 有 key 模式严格：任一脚本 `FAIL` / `ERROR` / 无结论行即 `COMPOSITION=FAIL`，按脚本自身 `RESULT=` / `拆分遵守率` 原样出报告。

**确定性实跑**：`--list` 0 执行通过；无 key 骨架自检 **2/2**（health `model=mock`、三份夹具就位）+ `COMPOSITION=NOT_VERIFIED`；`--mock` **5/5 脚本连上服务并按序执行**、`SERVICE_CHECKS=3/3`、`COMPOSITION=SKELETON_VERIFIED`（MockModel 下 3 个真模型判据 FAIL 属预期，如实打印、不算编排失败）；两种模式端口都正确释放。`test/acceptance-guard.test.mjs` 增至 **15 项**锁住端口/夹具/钉住断言/key 只走 env，全量 `npm test` / `check` **219/219**、`npm run acceptance` **243/243**、`node --check`、782 文件真实凭据 0 命中、无持久变量、无遗留监听。

**仍需新 key**：旧 key 已视为泄露须吊销/轮换，未复用。有 key 时一条命令即可跑完 §5 的真模型 11 组（`acceptance:real`）+ 组合 5 脚本（`acceptance:composition`），不必再手工起服务。

### 前端呈现补记

交付物诚实信号（`web/artifact-notes.js`）、错误时间线中文化（`web/error-copy.js`）、重复错误降权（`web/error-repeat.js`）三处都只改 `web/` 可改区，各带纯函数单测并注册进 `test`/`check`；正常路径零新增 `.row`，`cursor`/`seen`/SSE 过滤逻辑未动，DOM 冒烟 40 项钉住断言一字未改。分层实跑数字与当前状态见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)。

## 可移植性实跑（2026-11-07 整理）

| 场景 | 结果 |
| --- | --- |
| 原工作区 `npm test` / `check` | **265/265** 双跑 |
| 原工作区 `npm run acceptance` | **HTTP 203/203 + DOM 40/40 = 243/243**，INTEGRITY 13/13 |
| 复制到另一个完全不同路径后 `npm run acceptance` | **243/243**（同样 203/203 + 40/40），无需改任何文件 |
| 12 个钉住文件断言区对比备份 | **12/12 PASS**（移除路径行后逐字节一致） |
| 11 个 e2e Python AST 语法 | **0 失败** |
| `npm run acceptance:real`（无 key） | INTEGRITY 30/30、确定性剧本 **2/2 PASS**、`REAL_ACCEPTANCE=NOT_VERIFIED`（不冒充通过） |
| `npm run acceptance:composition -- --mock` | `SKELETON_VERIFIED`、`SERVICE_CHECKS=3/3`、5 个脚本按序执行（MockModel 下的 REJECTED 属预期，不算模型结论） |
| 密钥扫描 / 端口 | 真实凭据 0 命中、3201–3219 无遗留监听 |
