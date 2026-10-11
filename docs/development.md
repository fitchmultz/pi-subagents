# Development and validation

[Getting started](../README.md) · [Subagents reference](reference.md)

## Local validation

See [Code quality](code-quality.md) for the strict Oxlint/Oxfmt rules and commands. `npm run ci` runs lint and formatting before TypeScript, package checks and tests.

`npm run check:compat` uses the selected host installed in this checkout, never a hidden Pi from PATH. It runs full CI with actual native editor receipts: a supplied clean `PI_EDITOR_RECEIPT_TEST_ROOT` stays read-only, otherwise the owning runner snapshots public `pi-apply-edits` main once in a temporary checkout, records its exact Git SHA, installs only its third-party runtime dependencies, and cleans its owned copy. Repository CI resolves that editor SHA once for all host/platform lanes. It checks host SDK/manifest-bin identity, typechecks, builds, and qualifies both compiled entries with a private Intercom broker through the native SDK and bundled RPC CLI. Official hosts exercise same/different-cwd resume, acceptance, structured output, native result routing/ownership and tool activation. No provider credentials or inference services are used.

Repository CI resolves latest stable official Pi and maintained fork main once, then freezes that version/SHA across the Linux/macOS lanes and release qualification. Full `npm run ci`, selected-host native contracts, Git production builds and packed-install smokes remain required.

Fork jobs supply `PI_COMPAT_HOST=fork`, `PI_COMPAT_EXPECTED_VERSION`, `PI_COMPAT_EXPECTED_PACKAGE_DIR`, `PI_HOST_INDEX`, and `PI_HOST_CLI` to verify the selected SDK and CLI. The official job uses the resolved latest stable cohort with `PI_COMPAT_HOST=official`. Both targets use ordinary 1.0 lifecycle and finalized tool-result accounting, without checkpoint, immediate-usage or pending-call APIs. Unsupported hosts fail qualification rather than skip native checks. See [host capabilities](reference.md#host-capabilities-and-result-delivery) and [limitations](intercom.md#limitations).

For a fresh development worktree, run `npm ci` before launching Pi there: project-local `.pi/extensions` can autoload before dependencies exist. Alternatively launch from a neutral directory and use `change_dir` to enter the owned worktree after startup. Do not disable all extensions or remove project extensions to hide missing dependencies.

Use an empty HOME outside your real home ancestry and a short temporary directory whose ancestors have no project/package or agent markers. Set HOME, TMPDIR, TMP, TEMP, cache and fixture cwd consistently; never create mutable fixtures beneath the real home or retained evidence directory. Child tests use local fixtures and their own broker/profile. CI runs the latest Node 24 release on Linux and macOS without claiming a full platform-by-host matrix.

The completion guard recognizes verified `modifiedFiles` receipts from pi-apply-edits v1's `apply_patch`, `replace_text`, and `write_files`, including partial publication errors. Previews and unchanged results do not count as mutations. To exercise the real editor through native SDK events, use an installed v1 editor checkout:

```bash
PI_EDITOR_RECEIPT_TEST_ROOT=/absolute/path/to/pi-apply-edits \
  node --test test/integration/native-editor-receipts.test.ts
```

`PI_EDITOR_RECEIPT_TEST_SDK` selects another installed host package root; `PI_EDITOR_RECEIPT_EVIDENCE_DIR` retains receipts and fixture files. Without an editor checkout, this optional integration test skips.

### SDK embeddings of runtime-only installations

Before loading a pruned package with `DefaultResourceLoader`, set `process.env.PI_PACKAGE_DIR = getPackageDir()` from the **selected SDK**. This is the existing host-location contract for native session APIs and detached runners. Alternatively the host must be discoverable through the extension's dependency graph or an actual Pi executable on PATH. CLI consumers resolve their own host normally.

Detached history workers need one of those host-location sources to resolve the selected host's terminal-stripping implementation. The parent uses Pi's normal extension-loader imports without loading another runtime. Qualification covers both the explicit-host SDK path and the real bundled CLI with a production-only package.

To diagnose the full suite against the locked published Pi dependencies:

```bash
npm ci
npm run ci
```

The [host limitations](intercom.md#limitations) include historical official 0.87.1 results. Retain distinct queue and prompt-preparation checks and report their actual results for the selected host; portable qualification does not establish a full-suite pass.

That command runs TypeScript no-emit checking, package shape smoke checks, an isolated single-package install smoke, and the full unit/integration suite. The bundled agent tests cover the Fitch profile set directly, so validation does not require pi-fitch-kit. `npm test` is intentionally the fast unit-test shortcut (`npm run test:unit`), not the full completion gate.

For a credential-free Linux gate against committed `HEAD`, Docker and `PI_LINUX_PI_ARCHIVE` are required. Supply an absolute path to a `.tar.gz` containing one top-level `pi/`: a Pi 1.0 source checkout, its Linux `node_modules` (including workspace dependencies), and all built `dist/` output. It must include `pi/packages/coding-agent/dist/index.js` and `pi/packages/coding-agent/dist/bundle/cli.js`.

Prepare that checkout in a clean Linux build environment matching the image's CPU architecture and Node version. Install locked dependencies and complete Pi's workspace build, including its generated model data, before archiving. Do not copy host `node_modules`, Pi user state, `auth.json`, secret `.env` files, or credential-bearing npm/Git configuration. From the Linux build environment:

```bash
tar -czf /absolute/path/native-pi-linux-node24.tar.gz -C /clean/linux-build pi
```

Run with an archive matching the image:

```bash
PI_LINUX_PI_ARCHIVE=/absolute/path/native-pi-linux-node24.tar.gz \
  bash scripts/linux-smoke.sh
```

The archive is mounted read-only and extracted to `/native-pi`. The unprivileged `node` user installs locked package dependencies in `/workspace`, points the private CLI link and all SDK overrides at the supplied build, and runs the full, unchanged `npm run ci` gate. No host home, source mount, credentials, or model calls are passed into it. The gate does not patch Pi/Jiti or skip native cases.

## Real Pi smoke

The default local gate includes real SDK reload/reopen and native child-session ownership checks with a controlled CLI and no model calls. Other execution tests stay mock-heavy and deterministic. When you need to verify the actual local file-path Pi package boundary, run the opt-in real smoke:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
node scripts/real-pi-smoke.mjs
```

Use direct `node` invocation with the intended `pi` first on `PATH`. npm scripts prepend `node_modules/.bin`.

It installs this checkout into an isolated temporary Pi home, runs `pi list`, and loads the bundled subagent and intercom extensions. It does not install pi-fitch-kit, publish to npm, or use GitHub Actions.

Live model-backed subagent paths are intentionally opt-in because they can use provider credentials and tokens:

```bash
PI_REAL_SMOKE_MODEL=openai/gpt-6-astra node scripts/real-pi-smoke.mjs --llm
```

That mode copies local `auth.json` and `models.json` into the isolated Pi agent dir, then asks a real Pi session to exercise intercom status plus subagent list, waiting execution, background launch, and background completion. Set `PI_REAL_SMOKE_AUTH_AGENT_DIR` if your auth files are not in `~/.pi/agent`.

For a broader live gate, add `--llm-full`:

```bash
PI_REAL_SMOKE_MODEL=openai/gpt-6-astra node scripts/real-pi-smoke.mjs --llm-full
```

That also verifies real parallel, chain, file output, and acceptance flows. It checks actual tool calls and native settlement, and audits saved parent/child model identities. The smoke stops its own processes before removing copied credentials or artifacts, including on timeout or handled cancellation. Use `--keep-temp` to preserve noncredential evidence.

## Local test watchdog

`npm test`, `npm run test:unit`, `npm run test:integration`, and `npm run test:all` run through `scripts/run-tests.mjs`, which applies a per-suite local watchdog so hung child-process or worktree tests fail with the command context instead of hanging forever. The default is 300000ms for units and 1200000ms for integration. Override it when debugging slow local runs:

```bash
PI_TEST_TIMEOUT_MS=1800000 npm run test:integration
# or
node scripts/run-tests.mjs integration --timeout-ms 1800000
```
