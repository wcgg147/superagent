---
name: lauren-tan-pstack
description: Lauren Tan 的 pstack（Codex 移植版）技能库索引，63 个 SKILL.md + playbooks + agent personas。用于长任务防跑偏、追问前提、改动影响面、证据驱动验证、多 agent 编排、TDD、复盘。在本项目做长任务前先读项目根 AGENTS.md，再按需读这里的某个技能。
---

# Lauren Tan — pstack（技能库索引）

- 上游：Lauren Tan 的 [pstack](https://github.com/cursor/plugins/tree/main/pstack)（`cursor/plugins/pstack`）
- 本副本：`https://github.com/ScriptedAlchemy/pstack-codex`（Codex-native 独立移植版，MIT，见同目录 `LICENSE`、`UPSTREAM-README.md`、`UPSTREAM.json`）
- 内容：63 个 `SKILL.md`，原始文件完整保留在 `plugin/skills/<name>/SKILL.md`；playbooks 在 `plugin/skills/poteto-mode/playbooks/`
- 安装日期：2026-11-07；安装方式：git clone --depth 1 后原样复制 `plugins/pstack/`，未改写原始技能

> 上游 README 明确：repository-local skills 属于 `.agents/skills`，本安装位置与该约定一致。

## 优先级

**本项目根目录的 `AGENTS.md` 优先级高于本技能库。** pstack 的编排流程与本项目硬约束冲突时以 AGENTS.md 为准。特别是：

- 不要照搬 `swarm` / `arena` / `automate-*` 里的 git worktree、多机、PR 队列、自动落主干流程（本项目不做云、不做运维后台、执行面固定本机常驻进程）
- 不要照搬「never block on the human」：本项目**必须人在回路**，审批门、卡片确认、恢复需人点头是产品定义
- 不要为了让流程自洽而改回归断言或跳过验收

## 技能清单（按需读 `plugin/skills/<name>/SKILL.md`）

| 场景 | 技能 |
| --- | --- |
| 长任务总编排 / 防跑偏 | `poteto-mode`（含 `playbooks/`）、`sharpen`、`figure-it-out`、`recall`、`reflect` |
| 追问前提、别照单全收 | `interrogate`、`why`、`how`、`in-your-own-words`、`principle-attack-the-premise`、`principle-foundational-thinking` |
| 改动影响面与证明 | `blast-radius`、`show-me-your-work`、`benchmark-checklist`、`principle-prove-it-works`、`principle-explain-the-number` |
| 上下文窗口纪律 | `principle-guard-the-context-window`、`principle-minimize-reader-load`、`principle-subtract-before-you-add` |
| 设计与边界 | `architect`、`statechart`、`principle-boundary-discipline`、`principle-model-the-domain`、`principle-redesign-from-first-principles` |
| 根因与幂等 | `principle-fix-root-causes`、`principle-make-operations-idempotent`、`principle-sequence-verifiable-units`、`correct` |
| 测试 | `tdd`、`principle-test-behavior-not-implementation`、`unslop` |
| 文档与表达 | `technical-writing`、`teach`、`principle-encode-lessons-in-structure` |
| 显式调用型 | `setup-pstack`、`poteto-help`、`no-comments`、`ketchup` |

其余 `principle-*` 与 `create-*-verification-skill`、`maintain-*-verification-skill`、`automate-*` 属专项流程，按需查目录即可。

## 用法

1. 长任务开始前先读项目根 `AGENTS.md`。
2. 只挑当前阶段需要的**一个**技能读，不要把 63 个都灌进上下文。
3. 上游用 `$<skill-name>` 显式调用；本项目里把它当作「按需读取的参考资料」使用即可。
4. 技能与 AGENTS.md 冲突 → 停下说明，不自作主张。
