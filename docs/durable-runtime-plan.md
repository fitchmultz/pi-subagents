# Durable agent runtime

The runtime must let a parent delegate once, retain ownership, exchange questions without losing work, trust the result, and return to the same specialist later. Foreground and background select whether the parent waits; they must not select different retention or completion rules.

## Required behavior

- Deliver each intercom message once. Recover messages interrupted before handoff without replaying messages already recorded by Pi or starting retry-only model turns. Keep steer, deferred, passive, and coalesced milestone behavior.
- Retain run ownership, effective launch choices, results, and continuation history with persisted sessions. Reload, restart, list pagination, and temporary-file cleanup must not erase a saved run handle. Do not silently adopt another parent's work.
- Continue with the original effective model/provider, thinking, profile, tools, extensions, context, output, and acceptance choices unless the caller explicitly changes them. Inspection shows the actual choices and their source.
- Put unanswered questions, failures, and completed-but-unreviewed work first. Parent review is explicit and separate from execution, validation, and notification. Inspection, review, and a late nudge do not restart work.
- Share retry, acceptance finalization, and workflow decisions across the concrete foreground and detached hosts. Preserve successful sibling outputs as evidence when a group fails; do not run downstream steps after failed, paused, or detached work. Publish a dynamic collection only after its children and collection schema succeed.
- Require a full Pi restart for extension code updates. `/reload` must not claim changed code is active when the loader retains cached JavaScript. Continue supported settings, skills, and prompt refresh without a Jiti fork or per-extension cache workaround.

## Verification

Use actual Pi SDK/CLI boundaries with isolated sessions and controlled children/providers for deterministic reproduction. New regressions need a failing run against the original implementation and a passing run against the fix. Checks must cover delivery interruption and early prompt failure, reload/restart recovery, explicit configuration overrides, continuation lineage, review persistence, and cross-mode retry/finalization/workflow parity.

Run the package checks on macOS and supported Linux Node versions, native Pi's relevant checks, and isolated model-backed smoke tests using only `openai/gpt-6-astra` or `openai-codex/gpt-6-astra`. Keep existing capabilities; no rewrite, RPC migration, worker pool, replacement broker, new scheduler, same-user IPC permissions, or platform expansion.

## Dependency decision

Jiti's disabled module cache still uses native cached JavaScript for some extension imports. An isolated dependency patch demonstrated correct reloads, but Mitch chose full process restarts rather than maintaining a Jiti fork. The native change must make that boundary explicit and test that a fresh process loads the updated schemas. The upstream defect is already tracked in [Jiti #418](https://github.com/unjs/jiti/issues/418); [PR #462](https://github.com/unjs/jiti/pull/462) remains unmerged.

## Delivery boundary

Develop and verify in isolated worktrees. Keep installed code and active sessions untouched until both updates are ready. Publish the approved repository changes, then coordinate one full restart before testing the updated tools in active sessions.
