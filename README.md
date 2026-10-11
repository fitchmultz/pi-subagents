# pi-subagents

`pi-subagents` lets [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) delegate tasks to child sessions. Use it for code review, research, or implementation while you continue in the parent session.

![A Pi parent session delegates independent tasks to scout and reviewer children, then receives their saved results.](.github/readme/delegation.png)

## Install and start

Requires **Pi 1.0.0+** and **Node 24.21.0+**. Use macOS or Linux. Windows is not supported.

```bash
pi install npm:@fitchmultz/pi-subagents
pi
```

Enter a task in Pi:

```text
Use scout to explain the authentication code in this project.
```

The built-in agents are ready to use. See the [installation reference](docs/reference.md#installation) for Git installs and local checkouts.

## Run tasks

Ask Pi for a child by role and task:

```text
Have worker implement this approved plan, then ask reviewer to check the changes.
```

Children run in the background by default. You can also use commands:

| Task                 | Command                                                         |
| -------------------- | --------------------------------------------------------------- |
| Review a diff        | `/run reviewer "Review this diff"`                              |
| Run parallel tasks   | `/parallel scout "Inspect frontend" -> scout "Inspect backend"` |
| Run a sequence       | `/chain scout "Map auth" -> planner "Plan a refactor"`          |
| Run a saved workflow | `/run-chain scout-planner -- refactor authentication`           |

Add `--fg` to wait for the result. The [`forceTopLevelAsync` setting](docs/reference.md#forcetoplevelasync) disables waits when enabled.

The saved workflow example requires a [chain file](docs/reference.md#chain-files) named `scout-planner`. See the [command reference](docs/reference.md#direct-commands) for all options.

## Choose a role and model

| Task                         | Built-in agents                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Read code or gather evidence | `scout`, `context-builder`, `researcher`                                                |
| Plan or check a decision     | `planner`, `oracle`                                                                     |
| Implement or repair a change | `worker`, `debugger`, `fixer`, `delegate`                                               |
| Review a change              | `reviewer`, `reviewer-gpt`, `reviewer-claude`, `reviewer-security`, `reviewer-ponytail` |
| Design, write or monitor     | `ui-designer`, `writer`, `watcher`                                                      |

Ask Pi to show the effective profiles. Select an available model if a profile default is unavailable.

[Model settings](docs/reference.md#changing-a-builtin-agents-model) let you change a role without a copy of its agent file. Custom agents use `~/.pi/agent/agents/` or your project's `.pi/agents/`.

## Read results and continue work

The **Agents** area shows active tasks and tasks that need attention. Open `/agents` to browse active and finished conversations.

The shortcut is **Option+Shift+M** on macOS and **Alt+Shift+M** elsewhere.

- Open a conversation to read the child's report or send a message.
- Press F2 to inspect details or request cancellation with Stop.
- Select Continue to start follow-up work from a saved child session.
- Press Esc to return to the parent session.

Resume the same saved parent session with `pi --session /path/to/parent.jsonl` to recover runs and questions.

See the [conversation reference](docs/reference.md#try-this-first) for shortcuts, drafts and history search.

## Limits and warnings

Each child uses your provider account and can spend tokens. See [usage accounting](docs/reference.md#usage-accounting) for details.

Children normally inherit Pi's tools, extensions, project instructions and skills. Restrict [tools](docs/reference.md#tool-and-extension-selection) and [project trust](docs/reference.md#projecttrust) when a child must have limited access.

Intercom is included. It lets Pi sessions exchange messages and lets a child ask its parent for a decision.

Read the [Intercom guide](docs/intercom.md) for setup and host limits. The [secure bridge](docs/intercom-bridge.md) supports a remote Linux agent.

Indexed history requires SQLite 3.53.4 through Node's built-in `node:sqlite` binding. Other SQLite versions fail. See the [storage requirements](docs/performance.md#storage-budgets-and-recovery) and [host startup costs](docs/performance.md#necessary-costs-and-limits).

## Update and troubleshoot

An update can leave active sessions on old code. Close all Pi sessions that use this installation before an update.

Run this command from a separate terminal:

```bash
pi update --extension npm:@fitchmultz/pi-subagents
```

Start new Pi processes after the update. `/reload` does not reliably activate changed JavaScript.

Run `/subagents-doctor` to check delegation and Intercom setup. See the [installation reference](docs/reference.md#installation) for Git updates, local rebuilds and broker restarts.

## Documentation

- [Full reference](docs/reference.md): profiles, commands, configuration, workflows and saved run records.
- [Development](docs/development.md): builds, CI, compatibility checks and optional model smoke tests.
- [Example prompts](prompts/): saved examples for common tasks.
- [Changelog](CHANGELOG.md): changes by version.

## License

[MIT](LICENSE).
