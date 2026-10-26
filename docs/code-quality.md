# Code quality

Oxlint checks maintained TypeScript and JavaScript. Oxfmt owns formatting.
Both tools use the committed npm versions and repository configuration.

```sh
npm ci --ignore-scripts
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run typecheck
npm run ci
```

Lint rejects unsafe types, unchecked assertions, floating promises, accidental
mutation, import cycles and ambiguous control flow. Application readonly types
remain checked by TypeScript. `typescript/prefer-readonly-parameter-types` is
disabled: the published backend cannot express the existing native SDK aliases
with package-scoped allowances. The project does not patch the checker or add
production wrappers to satisfy that rule.

Production limits are complexity 10, depth 3, parameters 4, statements 40,
function lines 80 and file lines 500, excluding blank lines and comments.
Tests retain complexity 15, depth 4 and parameters 6. Cohesive test suites have
no size or statement limits.

Formatting uses width 100, two spaces, LF and double quotes. npm owns lockfile
formatting. Build outputs keep their own bytes.
The VS Code Oxc extension uses these same lint and formatting configurations.

`npm run ci` runs lint, formatting, TypeScript, package/install smokes and all
tests. CI separately qualifies the latest official Pi on GitHub-hosted Linux and
the maintained fork on Linux and macOS. There is no custom checker build, probe
suite or self-hosted runner requirement.

CI's lint job also enforces the production line/byte shrink budget before
qualification substitutes the selected host graph. The retired workflow schema
generator and its patching dependency are not part of the new runtime.
The active-child viewer, change-driven wakeups, idle-child parking and the
concurrent efficiency units have an approved aggregate budget of 19,750 source
lines and 23,500 production lines. The 1 MiB byte ceiling and all lint limits
stay unchanged.
