# Retired feature test inventory

These complete suites were read before removal. Their production owners and all callers were removed by the user-approved rebuild—not retained only for tests. This inventory is separate from the native safety transfer ledger in [test-retention.md](test-retention.md). The baseline is `1646ab895e25fb56847ad669733c55807bc8ff3c`.

The dispositions concern all cases in each listed file. Ordinary SDK resources, native receipts, current storage ownership, process cleanup and broker safety are not retired by these categories; their distinct keepers remain in the safety ledger.

## profile catalog editor and profile specific resources

- `test/unit/agent-disabled.test.ts`
- `test/unit/agent-frontmatter.test.ts`
- `test/unit/agent-management.test.ts`
- `test/unit/agent-overrides.test.ts`
- `test/unit/agent-scope.test.ts`
- `test/unit/package-agents.test.ts`
- `test/unit/path-resolution.test.ts`
- `test/unit/skills-fallback.test.ts`
- `test/unit/model-info.test.ts`

## workflow DSL acceptance structured capture and automatic worktrees

- `test/unit/acceptance.test.ts`
- `test/unit/typed-acceptance.test.ts`
- `test/unit/chain-serializer.test.ts`
- `test/unit/dynamic-fanout.test.ts`
- `test/unit/parallel-utils.test.ts`
- `test/unit/workflow-graph.test.ts`
- `test/unit/workflow-policy.test.ts`
- `test/unit/worktree.test.ts`
- `test/unit/single-output.test.ts`
- `test/unit/schemas.test.ts`
- `test/unit/everyday-tool-input.test.ts`

## removed Claude fallback and profile selected MCP admission

- `test/unit/claude-code.test.ts`
- `test/unit/model-fallback.test.ts`
- `test/unit/mcp-direct-tool-allowlist.test.ts`

## removed nesting child delegation and old control policy

- `test/unit/compact-child-tools.test.ts`
- `test/unit/nested-events.test.ts`
- `test/unit/async-control.test.ts`
- `test/unit/subagent-tool-loop-guard.test.ts`
- `test/unit/subagent-control.test.ts`
- `test/unit/completion-guard.test.ts`
- `test/unit/control-notices.test.ts`

## removed custom UI rendering compaction and prompt wrapping

- `test/unit/render.test.ts`
- `test/unit/widget-nested-render.test.ts`
- `test/unit/status-format.test.ts`
- `test/unit/status-normalization.test.ts`
- `test/unit/foreground-tool-call-compaction.test.ts`
- `test/unit/prompt-template-bridge.test.ts`
- `test/unit/types-fork-preamble.test.ts`

## removed history global discovery and legacy reconstruction

- `test/unit/async-result-file.test.ts`
- `test/unit/run-history.test.ts`
- `test/unit/run-records.test.ts`
- `test/unit/run-id-ambiguity.test.ts`
- `test/unit/run-id-resolver.test.ts`
- `test/unit/session-file.test.ts`
- `test/unit/temp-root-cleanup.test.ts`

## obsolete CLI watcher notification and output helpers

- `test/unit/pi-args-resume.test.ts`
- `test/unit/subagent-runner-launcher.test.ts`
- `test/unit/file-coalescer.test.ts`
- `test/unit/notify.test.ts`
- `test/unit/result-intercom.test.ts`
- `test/unit/detect-error.test.ts`
- `test/unit/get-final-output.test.ts`

## Retired integration feature owners

Profiles, workflow/acceptance/structured-output protocols, old history indexes, automatic workflow worktrees, child-delegation loaders, UI cards and slash-command bridges, the Claude backend, and the old streamed CLI status receiver are removed. Native tests of those removed features do not require reintroducing the feature. The old >512 MiB workflow-control backlog case belongs to its removed event-feed owner; the separate >512 MiB native journal/accounting proof is retained.

- `test/integration/acceptance-report-boundary.test.ts`
- `test/integration/agent-interaction.test.ts`
- `test/integration/async-job-tracker.test.ts`
- `test/integration/async-status.test.ts`
- `test/integration/chain-clarify.test.ts`
- `test/integration/chain-execution.test.ts`
- `test/integration/claude-code-execution.test.ts`
- `test/integration/detached-chain-completion.test.ts`
- `test/integration/doctor-executor.test.ts`
- `test/integration/feedback-ux.test.ts`
- `test/integration/history-index.test.ts`
- `test/integration/mixed-sibling-outcomes.test.ts`
- `test/integration/owned-result-retention.test.ts`
- `test/integration/owned-run-inspect.test.ts`
- `test/integration/owned-run-list.test.ts`
- `test/integration/parallel-execution.test.ts`
- `test/integration/render-fork-badge.test.ts`
- `test/integration/render-widget.test.ts`
- `test/integration/result-contracts.test.ts`
- `test/integration/slash-commands.test.ts`
- `test/integration/slash-live-state.test.ts`
- `test/integration/template-resolution.test.ts`
- `test/integration/tool-activation.test.ts`
- `test/integration/top-level-async.test.ts`
- `test/integration/compact-child-tools.test.ts`
- `test/integration/completion-guard-wakeup.test.ts`
- `test/integration/native-mcp-admission.test.ts`
- `test/integration/native-streaming.test.ts`
- `test/integration/native-structured-output.test.ts`
- `test/integration/legacy-result-recovery.test.ts`
