---
name: addyosmani-agent-skills
description: Addy Osmani 的 25 个生产级工程技能索引。用于规划拆解、规格驱动、增量实现、代码评审、调试、TDD、性能、安全、文档/ADR、上下文工程等通用工程流程。在本项目里做长任务、动手改代码前，先读项目根 AGENTS.md，再按需读这里的某个具体技能。
---

# Addy Osmani — Agent Skills（工程技能库索引）

- 来源：`https://github.com/addyosmani/agent-skills`（MIT，见同目录 `LICENSE` 与 `UPSTREAM-README.md`）
- 内容：25 个技能，原始文件完整保留在 `skills/<name>/SKILL.md`
- 安装日期：2026-11-07；安装方式：git clone --depth 1 后原样复制，未改写原始技能

## 优先级

**本项目根目录的 `AGENTS.md` 优先级高于本技能库。** 通用工程流程与本项目硬约束冲突时，一律以 AGENTS.md 为准。特别是：

- 不要照搬 `git-workflow-and-versioning` 的 PR / 分支流程（本项目不做提交流程、运维后台面已冻结）
- 不要引入云端 GUI / 云桌面 / 多机编排（执行面固定在用户本机常驻进程）
- 不要为了「让测试变绿」而放宽或删改既有回归断言

## 技能清单（按需读 `skills/<name>/SKILL.md`）

| 场景 | 技能 |
| --- | --- |
| 任务太大、要拆成可验证单元 | `planning-and-task-breakdown`、`incremental-implementation` |
| 先定规格 / 先质疑需求 | `spec-driven-development`、`idea-refine`、`interview-me`、`doubt-driven-development` |
| 约束优先、别过度设计 | `constraint-driven-development`、`code-simplification` |
| 上下文与记忆 | `context-engineering`、`source-driven-development` |
| 评审 / 质量 / 改动影响面 | `code-review-and-quality`、`api-and-interface-design` |
| 调试与恢复 | `debugging-and-error-recovery` |
| 测试 | `test-driven-development`、`browser-testing-with-devtools` |
| 发布与运维流程（本项目一般不适用） | `shipping-and-launch`、`ci-cd-and-automation`、`git-workflow-and-versioning` |
| 文档 | `documentation-and-adrs`、`deprecation-and-migration` |
| 性能 / 可观测 / 安全 | `performance-optimization`、`observability-and-instrumentation`、`security-and-hardening` |
| UI | `frontend-ui-engineering` |
| 元技能 | `using-agent-skills` |

## 用法

1. 长任务开始前先读项目根 `AGENTS.md`（尤其「禁改区」与「验收规矩」）。
2. 判断当前阶段属于上表哪一类，**只读那一个** `skills/<name>/SKILL.md`，不要一次把 25 个都灌进上下文。
3. 若技能要求的操作与 AGENTS.md 冲突，停下并说明冲突，不要自作主张。
