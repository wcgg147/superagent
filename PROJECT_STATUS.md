# 项目介绍与当前进度

> 这份文档是「**这是什么、做到了哪一步、哪些还没验证**」的单一可信来源。
> 开发规矩见 [AGENTS.md](./AGENTS.md)；产品方案、Grok Bot / Super-agent 调研与论文取舍见 [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md)；验收脚本、SHA-256 清单与真模型跑法见 [acceptance/README.md](./acceptance/README.md)；功能与命令细节见 [README.md](./README.md)。

---

## 1. 一句话介绍

**一个常驻在用户本机的 AI 同事**：给它一个名字和职责，它主动观察、并行推进、连续处理，把过程与结果都落在**同一条时间线**上，低打扰、人在回路。

技术形态：零依赖 Node ESM（Node ≥ 20）常驻进程 + 极简 Web 客户端；模型与执行面都通过接口替换，运行时不依赖构建工具或数据库。

### 它是产品形态 A，不是 B

| A（本项目） | B（明确不做） |
|---|---|
| 常驻同事 + 一条时间线 | Bot 运维 / 控制后台、多页签管理面 |
| 能力靠对话里的类型化卡片唤出 | 加渠道、团队额度、灰度、审计等控制面 |
| 执行落在用户本机进程 | 云电脑 / GUI 云桌面 / VNC |
| 时间线是唯一上下文源 | 第二套记忆 / 向量库 / 事实抽取 |

**不承诺**：关掉客户端后仍执行、每条消息都唤醒的宽监听、多对多订阅、完整链式召回、跨月长程记忆、A2A 网关。

---

## 2. 快速开始

```sh
# 运行时零依赖
npm start                    # 默认 http://127.0.0.1:3080
npm test                     # 确定性单测基线
npm run acceptance           # DOM 冒烟 40 + HTTP 端到端 203 = 243 项
```

- Windows 上 3080 可能落在动态端口排除段（`EACCES`），用 `PORT=3211 npm start` 换端口。
- 第三方模型 key **只走命令环境变量**、用后即弃、绝不落盘：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`；测试入口用 `DSH_TEST_KEY`。不配置 key 时是本地 MockModel，功能链路照常可跑。
- `npm run acceptance` 额外需要 Python 3 标准库与 `acceptance/ui-smoke/node_modules/jsdom`（仅验收期依赖）；`npm start` 与 `src/` 运行时仍是零依赖。
- `npm run acceptance:real` / `npm run acceptance:composition` 是 §5 第 3/4 步入口，需要真 key；无 key 时明确输出 `NOT_VERIFIED`，不冒充通过。

---

## 3. 宏观进度

四条**定义性能力已全部落地**并经过真模型或确定性验收，不是待办清单：

| # | 能力 | 状态 | 主要落点 |
|---|---|---|---|
| ① | 主动观察循环 | 已完成 | `src/observer.mjs` 四级闸门；环境变了**摆卡等人点头**，不自动派 turn |
| ② | 并发 turn + 统一出口 | 已完成 | `src/turns.mjs` 硬槽位（默认 3）；所有回复经 `ReplyOutbox`；一条消息多件事由 agent 自己拆开并行 |
| ③ | Thread 串联 | 已完成 | `src/threads.mjs` 程序侧稳定分组 + `afterSeq/throughSeq` 水位增量召回 |
| ④ | 长任务可见 / 可中断 / 恢复 | 已完成 | `src/watchdog.mjs` + `Engine.resume()`；逐步 progress、精确停止、重启**不自动续跑** |

在其之上补齐的产品能力（都不是新主线）：

| 补强 | 状态 | 效果 |
|---|---|---|
| 插话不终止在跑的 turn | 已完成 | 新消息并行处理，不杀当前任务 |
| 主动回访 | 已完成 | 每次最多一条 + 每 Bot 冷却 + 忙碌不插话 + 同一件只提一次 |
| 跨轮实体召回 | 已完成 | 说「package.json 那件事」能找回上次的结论 |
| 交付能力（附件 / 预览 / 回读校验） | 已完成 | 交付物转可下载链接，写完回读 `integrity`，时间线带正文预览 |
| 长文档分页续读 | 已完成 | 25K 文档可读到 16K 之外；模型显式写 `文件名 @16000` 续读，系统不自动翻页 |
| 长文档交付不丢页 | 已完成 | `write_artifact` 从时间线读回本 turn 全部 browse 页，按既有 16000 预算分批 compose |
| 交付物诚实信号 | 已完成 | 降级 / 分批 / 材料来源 / 材料有界在卡片上中文化可见 |
| 错误时间线中文化 + 低打扰 | 已完成 | 内部错误码留在 journal，用户看到普通理由与下一步；重复瞬断只说全一次 |
| 多 Bot / 群聊 / SSE 隔离 | 已完成 | SSE 推送带 `botId`，切 Bot 游标重置并完整重建 |

**明确没做、且不在本阶段计划内**：云电脑 / GUI / VNC、关客户端仍执行、独立语义 Watchdog Session、Router-Worker 双层、完整链式召回、Inline & Spill、A2A 网关、控制面新增页签。DSH 只是可选灰度执行面，不是默认。

---

## 4. 细节说明

### 4.1 仓库结构

```
.agents/skills/   开发期资料（保留）：Addy Osmani 25 个工程技能、Lauren Tan pstack
                   63 个技能 + playbooks；第三方 MIT，索引见各自 SKILL.md
src/            15 个模块：状态机、时间线、上下文、并发槽位、观察、回访、
                Watchdog、模型/执行面 provider、HTTP 服务与路由
web/            极简客户端：index.html、app.js、p1.js、style.css，
                加 4 个零依赖纯函数模块（连接状态 / 交付物提示 / 错误文案 / 重复降权）
test/           26 个 Node 单测文件，265 项断言，全部注册进 test / check
acceptance/     验收资产：13 个钉住脚本 + 17 个真模型/组合脚本 + 3 个驱动
                + manifest.json / manifest-real.json（SHA-256 完整性闸门）
AGENTS.md                     工程规矩：硬约束、禁改区、验收流程
SUPERAGENT_PRODUCT_PLAN.md   产品方案 v3、Grok Bot / Super-agent 调研与论文取舍
README.md                     功能清单、命令、API 与体验走查
PROJECT_STATUS.md             本文件
```

运行时数据（`.data/`、`materials/`、`artifacts/`）与验收期 `node_modules/` 都在 `.gitignore` 中，不进仓库。

### 4.2 核心不变量

这些由 [AGENTS.md](./AGENTS.md) §3 钉住，改动需先写清「改哪条、为什么、如何重新验收」：

- **时间线是唯一上下文源**：`src/journal.mjs` append-only，`seq` 从 1 严格单调递增，`read(cursor)` 增量、`tail()` 有界、`clientNonce` 幂等；不在上游另建索引或摘要存储。
- **统一回复出口**：`src/turns.mjs` 的 `ReplyOutbox`，所有 `assistant/message` 必须 `viaOutbox:true`（含插话确认、回访、交付说明）。
- **唯一决定「这一轮它知道什么」的地方**：`src/context.mjs` 有界装配 `recent` / `skills` / `related` / `openWork` / `priorDeliverables` / `interjection`。
- **步骤瞬时失败 ≠ 任务死亡**：纯规划可退避重试；**执行中的步骤绝不重试**（命令 / 交付物不能跑两次）；耗尽保住 `index`、置可续跑、出「接着做」卡。
- **人在回路**：有后果的命令必须审批；中断 / 重启作废待审批；恢复要人点头；观察只摆卡不自动派活。
- **材料有界且诚实**：指名文件给 16K 全文，只给关键词才给 800 字符定位片段；超预算标 `truncated` / `offset`，要求模型「缺什么就明说、不编造」。
- **弱模型靠系统兜底**：占位正文检测、compose 重写、材料兜底、卡片确认、分级 effort、两阶段规划、显式降级（降级要在时间线上说清楚，不许静默）。
- **凭据安全**：`SecretBroker` / `sanitizeSecrets` 不泄露凭据；key 不写进代码、文档、journal、store、日志。

### 4.3 长文档链路（最近几轮的主要补强）

1. `LocalExecutor.browse` 支持显式分页（`文件名 @<offset>`），返回 `page` / `nextOffset`；越界诚实返回空。
2. `write_artifact` 用 `collectTurnMaterials()` 从 append-only journal 读回**本 turn 全部** browse 页，按 `title+offset` 去重、按 offset 排序；最多 8 页 / 64000 字符，超限标 `truncated`。
3. `splitMaterialsForCompose()` 按既有 `COMPOSE_BUDGET=16000` 分批调用再按序拼接；任一批失败**不拼接半截**，整体降级到全文材料兜底，artifact 事件标 `composeBatches` / `composeDegraded`。
4. 前端 `web/artifact-notes.js` 把这些信号中文化显示；正常单批 compose **零新增 DOM**。

单批场景与原实现等价，预算值与 `composeUser` 裁剪逻辑未改。

### 4.4 错误呈现

`web/error-copy.js` 按结构化 `family` / `code` 把错误行中文化、脱敏、分级：代理瞬断（含 `NO_CREDENTIAL`）→「模型服务这次没接上，直接再发一次就行，不用改本机配置」；`USAGE_LIMIT` 单独醒目；网络瞬断 / 停步可续跑走柔和低打扰；白名单 / 版本钉扎 / 完整性等程序侧明确拒绝保留诚实中文原文。`web/error-repeat.js` 让同一 Bot / 同一轮的同款可重试瞬断首条说全、后续只留极淡的「· 同样的问题，第 N 次」。

**刻意不折叠**：每条 journal 事件仍 append 一个 `.row`，`seen` / `cursor` 逐条记账、每行带自己的 seq。折叠会让时间线看起来吞了事件，也与「DOM 与 API 可见条目不丢 / 不重 / 不多」冲突。

`src/providers.mjs` 的错误族与码未改，内部原文仍留在 journal 供排查。

---

## 5. 验收状态（分层，不互相冒充）

| 层 | 命令 / 判据 | 当前结果 |
|---|---|---|
| 确定性单测 | `npm test` / `npm run check` | **265/265** 双跑通过 |
| 前端 / HTTP 回归 | `npm run acceptance` = DOM 冒烟 40 + HTTP 端到端 10 组 203 | **243/243 PASS**（40 项钉住断言一字未改，SHA-256 完整性 13/13） |
| 真模型清单完整性 | `npm run acceptance:real -- --list` | **INTEGRITY 30/30** |
| 组合清单 | `npm run acceptance:composition -- --list` | 0 执行（仅列计划） |
| jsdom 真实 SSE 路径 | 交付物 / 错误 / 重复降权渲染 | **6/6 + 6/6 + 8/8** |
| 真实 HTTP 进程 | 静态模块送达、MIME、端口释放 | 通过 |
| 收尾 | `node --check`、密钥扫描 0 命中、无遗留监听 | 通过 |
| 可移植性 | 复制到完全不同路径后 `npm run acceptance` | **243/243 PASS**（无需改任何文件，AGENTS.md §3.4） |
| 无 key 真模型入口 | `npm run acceptance:real` | 确定性剧本 **2/2 PASS** + `REAL_ACCEPTANCE=NOT_VERIFIED` |
| 组合骨架 | `npm run acceptance:composition -- --mock` | `SKELETON_VERIFIED` / `SERVICE_CHECKS=3/3` |

**历史真模型验收结论**（在 §3.3 改动之前实跑，判据只看链路结构或交付物正文，不评生成质量）：全功能联调 HARD 98/98、多 Bot/群聊/SSE HARD 30/30、截断诚实性 HARD 5/5、P1/P2 HARD 23/23、the agent harness 真实 CLI HARD 23/23；三个常驻循环（观察 / 回访 / Watchdog）由**定时器自驱**验过，不是手动 `flush()` / `scan()` / `tick()` 冒充。

**未验证**：§3.3 分批 compose 之后的**真模型全套未重跑**。旧 key 曾贴进聊天、视为已泄露须吊销/轮换，需要一把新 key 通过命令环境变量注入，跑 `npm run acceptance:real` + `npm run acceptance:composition`。确定性 265/265 只证明链路接得住，不证明真模型按新分批契约自觉产出。

---

## 6. 已知上限（不是缺陷，是边界）

- **SOFT 能力触发率不是 100%**：自主并行在代理限流下会显式降级，并在时间线上说明。
- **定时器延迟有长尾**：观察 4.1–22.5s、事件→主动开口 8.3–28.1s；连续编排时 `soak_all.py` 曾因长尾 `BROKEN`（单独重跑 VERIFIED）、`split_quant` 4/5 PARTIAL、`p12_accept` 1 条 SOFT MISS。
- **材料单次有界**：单次 browse 16K 全文 / 关键词 800 片段，交付物最多纳入 8 页 / 64000 字符。
- **分批 compose 拼接可能带重复标题**：属生成质量，按项目约定不评文采。
- **服务级确定性冒烟 9/9 + 8/8 + 9/9** 是上一轮记录，最近一轮未重跑（最近几轮只改 `web/` 呈现层，未碰 `src/`）。

---

## 7. 开源前状态（技术项已全部处理，只剩真模型回归需要新 key）

1. **许可证（已解决）**：按项目所有者选择采用 **MIT**，见 [LICENSE](./LICENSE)；与仓库内两个第三方技能库的许可一致。版权行写的是 `Resident Agent contributors`，如需改成你的名字或组织，只改那一行即可。
2. **验收脚本可移植性（已解决）**：确定性 243 层不再硬编码开发机路径——11 个 `e2e*.py` 与 `ui-smoke/run.mjs` 从脚本自身位置推导工作区，`manifest.json` 重生成，`run.mjs` 改为更严格的「禁止任何开发机绝对路径」；12/12 文件证明除路径行外断言逐字节未变，并已把仓库复制到另一个完全不同的路径实跑 **243/243**。**真模型层**（`acceptance/real/*.py`）仍带开发机路径，因为其 `manifest-real.json` 断言区哈希被 `test/acceptance-guard.test.mjs`（禁改区）钉住；该层本来就需要 key、外部 DSH CLI 与 3211 服务，迁移办法见 [acceptance/README.md](./acceptance/README.md)「不变量保护」。
3. **凭据**：仓库内无真实 key；历史贴进聊天的 key 视为已泄露，应吊销/轮换。真模型跑法只从命令环境变量读取，不写文件。
4. **第三方资料（已解决）**：两个工程技能库按项目所有者要求**保留在 `.agents/skills/`**（Addy Osmani 25 技能、Lauren Tan pstack 63 技能 + playbooks，含第三方语料、图片与 MIT LICENSE）。删除后已完整恢复：**698/698 文件逐字节一致**（694 个上游原始文件与源比对、2 个 `UPSTREAM-README.md` 按原始安装命令从上游 README 复制、2 个 `SKILL.md` 从会话日志还原并与创建时的 `afterHash` 校验），0 缺失、0 不一致。随 GitHub 发布时须保留各自的 `LICENSE` 与 `UPSTREAM-README.md` 中的出处。两个 `UPSTREAM-README.md` 是上游 README 副本，其中部分相对链接指向上游仓库未收录的 `docs/`，属预期、未改写（保持逐字节原样）。产品方案文档中的 Grok Bot / Super-agent / 论文调研引用同样保留。

**真模型全套回归的唯一前置**：拿到一把新 key 后，按 [acceptance/README.md](./acceptance/README.md)「key 的处理」一节的命令，把 `DSH_TEST_KEY`（及 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` 等非凭据变量）**只注入当前命令的环境**，跑 `npm run acceptance:real` 与 `npm run acceptance:composition`。旧 key 已泄露须先吊销/轮换；仓库里没有任何 key。

---

## 8. 文档导航

| 想看什么 | 去哪 |
|---|---|
| 能不能跑、怎么跑、有哪些命令 | [README.md](./README.md) |
| 为什么这么设计、调研了什么 | [SUPERAGENT_PRODUCT_PLAN.md](./SUPERAGENT_PRODUCT_PLAN.md) |
| 改代码前必须知道的不变量与验收规矩 | [AGENTS.md](./AGENTS.md) |
| 验收脚本、清单、真模型 HARD/SOFT 分层 | [acceptance/README.md](./acceptance/README.md) |
| 开发期工程技能库索引 | [.agents/skills/addyosmani-agent-skills/SKILL.md](./.agents/skills/addyosmani-agent-skills/SKILL.md) / [.agents/skills/lauren-tan-pstack/SKILL.md](./.agents/skills/lauren-tan-pstack/SKILL.md) |
| 当前进度、验证到哪一步、还剩什么 | 本文件 |
