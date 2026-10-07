#!/bin/bash
# Immutable runner hook: no workspace/toolchain execution and no public context output.
set -euo pipefail
export PATH=/bin:/usr/bin:/usr/sbin:/sbin
. /Library/ProtectedCIHooks/job.conf
[ "${RUNNER_NAME:-}" = "$EXPECTED_RUNNER" ] || exit 1
for value in "${GITHUB_REPOSITORY:-}" "${GITHUB_SHA:-}" "${GITHUB_REF:-}" "${GITHUB_EVENT_NAME:-}" "${GITHUB_RUN_ID:-}" "${GITHUB_RUN_ATTEMPT:-}" "${GITHUB_JOB:-}" "${GITHUB_WORKFLOW_REF:-}"; do
  case "$value" in ''|*$'\n'*|*$'\r'*) exit 1 ;; esac
done
set -C
printf '%s\n' "$$" "$OPERATION_ID" "$NONCE" "$RUNNER_NAME" "$GITHUB_REPOSITORY" "$GITHUB_SHA" "$GITHUB_REF" "$GITHUB_EVENT_NAME" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$GITHUB_JOB" "$GITHUB_WORKFLOW_REF" > /Users/ci/.protected-job/capture
# The stream binds this exec continuation to the original Bash attempt. The native
# consumer checks its own audit token; a later shell cannot reuse a nonce-only ACK.
exec /Library/ProtectedCIHooks/observer --job-consume "$NONCE"
