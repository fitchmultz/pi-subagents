#!/usr/bin/env bash
set -euo pipefail

# Validate committed HEAD without passing host credentials or mounting the checkout.
git -C "$(dirname "$0")/.." archive HEAD | docker run --rm --init -i \
  "${PI_LINUX_IMAGE:-node:24-bookworm}" bash -c '
set -euo pipefail
mkdir /workspace
tar -xf - -C /workspace
chown -R node:node /workspace
runuser -u node -- bash -c '\''
set -euo pipefail
cd /workspace
node --version
npm --version
uname -sm
npm ci
export PATH="$PWD/node_modules/.bin:$PATH"
pi --version
npm run ci
'\''
'
