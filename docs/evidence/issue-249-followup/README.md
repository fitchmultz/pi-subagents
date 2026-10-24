# Hosted-teardown and physical-alias follow-up

This is a new evidence epoch after `576587ab4e4326782bb3a90d38c4b0a174242ca6`, not a relabeling of the original investigation or executable-route remediation. Those directories and their identities remain unchanged. Their source hashes describe their original revisions, not this later checkout.

## Observed failures and bounded fixes

All three head576 qualification lanes passed integration tests and the production Git/native install smokes, then failed strict `ci-host.mjs` teardown with `EACCES`. The complete logs are retained here: official Linux job120925592594, fork Linux job120925592608, and fork macOS job120925592534, run40112011547. Linux passed226 integration cases; macOS passed225 with one Linux-only skip. This is **failed CI**, not a green qualification. Retained foreign-owned ancestor fixtures were allocated under the harness's disposable `TMPDIR`.

Retired-history fixtures and the incoming native-attachment journal now allocate directly under `/tmp`, outside that owned cleanup scope, as the observation fixture already does. No foreign ownership/mode is normalized, teardown error suppressed, harness cleanup elevated, or journal deleted. The actual hosted teardown remains the integration keeper. A proposed helper-only lifetime test was rejected as suite scaffolding before commit; its native red/green observations and roots remain evidence, not a repository regression test.

[Cursor finding4367786964](https://github.com/fitchmultz/pi-subagents/pull/251#discussion_r4367786964) independently demonstrated a real bind alias bypassing lexical overlap checks. `prepare` now compares each archive/record parent with the source's native device+inode **before** creating a container or record. Two shipped-command tests use real Linux bind mounts in private mount namespaces, verify the alias's native identity independently, and check source inventory and metadata absence. Removing the guard makes both fail with `E_UNKNOWN_MEMBER` instead of `E_OVERLAPPING_PATHS`; the contaminated synthetic sets remain preserved. These checks do not establish future-writer exclusion.

## Final local qualification

- `focused-final.log`:21 actual-command/native preservation cases passed, zero skips.
- `archive-node24.4-final.log`:18 shipped-route cases passed on actual Node24.4.0, zero skips. Official tarball SHA256 verification is recorded separately. The two alias fixtures are Linux-only; macOS does not pretend to exercise Linux bind mounts.
- Lint:0 warnings/errors; format, TypeScript, unchanged size ceilings and installed-package/native smoke passed.
- An actual temporary production npm install of the packed artifact contains byte-identical command code; its installed `node_modules` command ran `--help` on Node24.4.0 without a TypeScript loader. This does not qualify the entire SDK matrix on minimum Node.
- `source-hashes.sha256` binds these final sources. Command SHA256: `eb3965d4913dac7033b49ceda63f447479f05e3bad2376fe2286b4e79501c0a2`.
- Independent same-model static follow-up review found no findings; no execution or hosted-review authority is inferred from it.

The local recipe retains the strict UID0 filesystem-root guard. It uses actual private mount/PID namespaces, a fresh self-bound UID0 root, read-only worktree and selected Node binary, real proc/lsof and distinct tmpfs. Self-binding the fresh root before child mounts fixed an initial local prerequisite `EINVAL` when nested `unshare` tried to change propagation in a non-mountpoint chroot. The failed attempt and initial skip-style lint failure are retained, not called successful mutation evidence. No original database recovery/checkpointing, machine-root chown, fake inspector or production bypass was used.

## Evidence retention and limits

`native-roots.tsv` names nine workspace roots covering authoring, failed prerequisites, negative controls and final runs. All126 JSONL entries are preserved both physically and in `synthetic-fixtures.tar.gz`; `jsonl-inventory.txt` was checked against the packet. Generated auth/model/settings stores, compiler caches and socket endpoints are omitted. Complete SQLite file sets remain included. Disposable `/dev/null` and `/dev/zero` aliases were removed only after namespace processes exited; fixture data was not cleaned.

The packet contains intentional refusal links and foreign ownership. Extract only into a disposable private directory. Native device/inode values describe original roots, not identities of extracted copies. Raw workspace roots remain the identity-bearing originals.

Fresh full hosted CI and all enabled current-head reviews remain required after pushing. No local result here declares them green. No live maintenance, installed-runtime activation/restart, private corpus access, purge, merge, release or deployment occurred. Archive-only reclaimed original allocations remain **zero**.
