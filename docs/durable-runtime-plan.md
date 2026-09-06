# Durable agent runtime

The runtime must let a parent delegate once, retain ownership, exchange questions without losing work, trust the result, and return to the same specialist later. Foreground and background select whether the parent waits; they must not select different retention or completion rules.

## Required behavior

- Deliver each intercom message once. Recover messages interrupted before handoff without replaying messages already recorded by Pi or starting retry-only model turns. Keep steer, deferred, passive, and coalesced milestone behavior.
- Retain run ownership, effective launch choices, results, and continuation history with persisted sessions. Reload, restart, list pagination, and temporary-file cleanup must not erase a saved run handle. Do not silently adopt another parent's work.
- Continue with the original effective model/provider, thinking, profile, tools, extensions, context, output, and acceptance choices unless the caller explicitly changes them. Inspection shows the actual choices and their source.
- Put unanswered questions, failures, and completed-but-unreviewed work first. Parent review is explicit and separate from execution, validation, and notification. Inspection, review, and a late nudge do not restart work.
- Share retry, acceptance finalization, and workflow decisions across the concrete foreground and detached hosts. Preserve successful sibling outputs as evidence when a group fails; do not run downstream steps after failed, paused, or detached work. Publish a dynamic collection only after its children and collection schema succeed.
- Require a full Pi restart for extension code updates. `/reload` must not claim changed code is active when the loader retains cached JavaScript. Continue supported settings, skills, and prompt refresh without a Jiti fork or per-extension cache workaround.

## Implemented scope

Native parent `subagent-run` entries retain ownership, review, and continuation links. Launch contracts, questions, and results live under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/subagent-runs`, outside temporary-log cleanup. Intercom checkpoints pending delivery in the owning native session and reconciles native queues and full-session receipts without replaying consumed messages; cold recovery preserves deferred, passive, and latest-milestone behavior without artificial accepted-message caps.

Foreground and detached hosts share retry, acceptance finalization, and workflow decisions. Finalization returns a standalone full handoff with cumulative evidence; successful sibling results remain available when a workflow stops. Native SDK regressions cover reload and fresh-process recovery of delivery and owned runs.

## Verification

Use actual Pi SDK/CLI boundaries with isolated sessions and controlled children/providers for deterministic reproduction. New regressions need a failing run against the original implementation and a passing run against the fix. Checks must cover delivery interruption and early prompt failure, reload/restart recovery, explicit configuration overrides, continuation lineage, review persistence, and cross-mode retry/finalization/workflow parity.

Run the package checks on macOS and supported Linux Node versions, native Pi's relevant checks, and isolated model-backed smoke tests using only `openai/gpt-6-astra` or `openai-codex/gpt-6-astra`. Keep existing capabilities; no rewrite, RPC migration, worker pool, replacement broker, new scheduler, same-user IPC permissions, or platform expansion.

## Dependency decision

Full support requires native `fitchmultz/pi` commit [`acf4c2d98ec44de2108f16a47bf59de5193341a7`](https://github.com/fitchmultz/pi/commit/acf4c2d98ec44de2108f16a47bf59de5193341a7), which includes the custom-queue reporting fix (`7679cb7b5`) and the restart notice/tests. Stock Pi 0.84.x and 0.85.1 both fail the custom-queue contract. The corrected build also reports 0.85.1; development pins and version output do not identify the fix. [Native PR #9](https://github.com/fitchmultz/pi/pull/9) contains these core fixes.

Jiti's disabled module cache still uses native cached JavaScript for some extension imports. An isolated dependency patch demonstrated correct reloads, but Mitch chose full process restarts rather than maintaining a Jiti fork. The native change makes that boundary explicit and tests that a fresh process loads updated schemas. The upstream defect is tracked in [Jiti #418](https://github.com/unjs/jiti/issues/418); [PR #462](https://github.com/unjs/jiti/pull/462) remains unmerged. No Pi/Jiti dependency patch belongs in this package.

## Delivery boundary

Release requires parent review, the full macOS/Linux package gates against the corrected native build, and isolated model-backed smoke tests. The Linux gate takes a credential-free prebuilt native archive and keeps every package test; see [local validation](../README.md#local-validation) for the archive shape and both SDK overrides.

Keep installed code and active sessions untouched until both updates are approved for delivery. Checkpoint and fully quit every Pi session using the affected installation, then wait at least five seconds after the last broker disconnect. Rebuild and update both packages from a separate terminal before reopening Pi. Resume the same saved parent session before testing active tools; a new or forked parent must not adopt the original parent's runs or pending intercom delivery.
