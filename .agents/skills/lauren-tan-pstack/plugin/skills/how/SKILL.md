---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
---

Before following this workflow, read [the Codex runtime contract](../../CODEX.md). It defines plugin paths, model configuration, delegation, and persistence.

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Resolve the named role line in `~/.codex/pstack-models.md` before each spawn, following `CODEX.md`: missing lines use the default, `auto` and `inherit-parent` omit both overrides, and unavailable choices are reported with inheritance as the explicit fallback. Split `model @ effort` into separate host fields.

Explorers use `how explorer` (default `gpt-6.1-sol @ xhigh`); every explainer uses `how explainer` (default `gpt-6-astra @ xhigh`). Forbid writes and mutating commands in their prompts. Run parallel explorers in waves when host capacity is smaller than the panel. Pick reasoning effort for the job under the Subagents section of **poteto-mode**, using only the active execution tool’s supported values.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. Spawn one explainer that explores and explains in one pass, built from `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn explorers asynchronously within available capacity, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one explainer with `references/explainer-prompt.md` and every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
