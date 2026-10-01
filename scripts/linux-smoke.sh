#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  printf '%s\n' 'Usage: bash scripts/linux-smoke.sh

Validate committed HEAD in Docker against a credential-free, prebuilt Pi 1.0
Linux archive with a single top-level pi/ directory and built SDK/CLI output.

Example:
  PI_LINUX_PI_ARCHIVE=/tmp/pi-linux.tar.gz bash scripts/linux-smoke.sh

Environment:
  PI_LINUX_PI_ARCHIVE  Absolute archive path (required)
  PI_LINUX_IMAGE      Node 24.21.0+ Linux image (default: node:24-bookworm)

Exit codes: 0 passed; 1 validation failed; 2 invalid arguments.'
  exit 0
fi
if [[ $# -ne 0 ]]; then
  printf '%s\n' 'No arguments accepted; use --help.' >&2
  exit 2
fi
: "${PI_LINUX_PI_ARCHIVE:?Set PI_LINUX_PI_ARCHIVE to an absolute path to a credential-free prebuilt Linux Pi 1.0 .tar.gz (top-level pi/) with its Linux dependencies and built SDK/CLI.}"

# Validate committed HEAD without passing host credentials or mounting the checkout.
git -C "$(dirname "$0")/.." archive HEAD | docker run --rm --init -i \
  --mount "type=bind,src=$PI_LINUX_PI_ARCHIVE,dst=/native-pi.tar.gz,readonly" \
  "${PI_LINUX_IMAGE:-node:24-bookworm}" bash -c '
set -euo pipefail
mkdir /workspace /native-pi
tar -xf - -C /workspace
tar -xzf /native-pi.tar.gz -C /native-pi --strip-components=1
chown -R node:node /workspace /native-pi
runuser -u node -- bash -c '\''
set -euo pipefail
cd /workspace
node --version
npm --version
uname -sm
npm ci
ln -sf /native-pi/packages/coding-agent/dist/bundle/cli.js node_modules/.bin/pi
export PI_INTERCOM_TEST_SDK=/native-pi/packages/coding-agent
export PI_OWNERSHIP_TEST_PACKAGE_ROOT="$PI_INTERCOM_TEST_SDK"
export PI_CONTEXT_TEST_PACKAGE_ROOT="$PI_INTERCOM_TEST_SDK"
export PI_PACKAGE_DIR="$PI_INTERCOM_TEST_SDK"
export PATH="$PWD/node_modules/.bin:$PATH"
pi --version
npm run ci
'\''
'
