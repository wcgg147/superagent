---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
---

Before following this workflow, read [the Codex runtime contract](../../CODEX.md). It defines plugin paths, model configuration, delegation, and persistence.

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Resolve the named role line in `~/.codex/pstack-models.md` before each spawn, following `CODEX.md`: missing lines use the default, `auto` and `inherit-parent` omit both overrides, and unavailable choices are reported with inheritance as the explicit fallback. Split `model @ effort` into separate host fields.

## When to invoke

Invoke when the user says "reflect" or "$reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Use the current transcript path or session ID exposed by the host when available. Otherwise inspect candidate `~/.codex/sessions/YYYY/MM/DD/*.jsonl` files only in the relevant session date directories. Read each first `session_meta` record before any transcript body, require an exact `payload.cwd` workspace match, and match `payload.id` to the current session when known. Never sweep unrelated workspaces or use a transcript's body to infer workspace ownership.

If the active path cannot be established, pass a tight digest of this conversation instead. Older workspace-matched sessions are not substitutes for the active chat.

## 2. Spawn three reviewers in parallel

Three asynchronous `spawn_agent` calls in capacity-bounded waves using the `default` agent, the named role line and default on each, and normal write-capable mode. Reviewers need MCP access for context lookups referenced in the transcript. Subagents inherit the parent's available MCP tools. Pick reasoning effort for the job under the Subagents section of **poteto-mode**, using only the active execution tool’s supported values.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` (default `gpt-6-astra @ xhigh`) | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` (default `gpt-6.1-sol @ xhigh`) | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` (default `gpt-6-astra @ xhigh`) | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final response.

## 3. Synthesize

One `spawn_agent` call using the `default` agent and `reflect judgment, divergent, synthesizer` line (default `gpt-6-astra @ xhigh`) in normal write-capable mode. The synthesizer spot-verifies citations and may need inherited MCP tools. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `plugins/cache/`. Before approval, show its destination: `.agents/skills/<skill>/` for the repository, or `$CODEX_HOME/skills/<skill>/` (default `~/.codex/skills/<skill>/`) for personal skills. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to Codex's `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but did not trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
