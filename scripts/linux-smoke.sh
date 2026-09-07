#!/usr/bin/env bash
set -euo pipefail

: "${PI_LINUX_PI_ARCHIVE:?Set PI_LINUX_PI_ARCHIVE to an absolute path to a credential-free prebuilt Linux Pi .tar.gz (top-level pi/) containing 9e85002de; stock Pi 0.84 and published 0.85.1 lack the required custom-queue and --session-cwd contracts.}"

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
