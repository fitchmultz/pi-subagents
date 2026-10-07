#!/bin/bash
# Root-owned launcher runs only after sudo has changed to the standard CI UID.
set -euo pipefail
[ "$(/usr/bin/id -u)" = 502 ] || exit 1
[ ! -e /Users/ci/runner/.env ] && [ ! -e /Users/ci/runner/.path ] || exit 1
cd /Users/ci/runner
printf 'PROTECTED_LISTENER %s\n' "$$"
IFS= read -r ACTIONS_RUNNER_INPUT_JITCONFIG
[ -n "$ACTIONS_RUNNER_INPUT_JITCONFIG" ] || exit 1
export ACTIONS_RUNNER_INPUT_JITCONFIG
# No JIT argv/file or long-lived parent shell environment.
exec /Users/ci/runner/bin/Runner.Listener run
