# pi-subagents

One Pi extension for delegation and local agent communication. Three tools, one
agent type, no profile bodies.

```bash
pi install npm:@fitchmultz/pi-subagents
```

A main session supplies the child's complete assignment:

```js
delegate({
  prompt:
    "Inspect the authentication changes. Return concrete defects with file and line evidence. Do not edit files.",
  name: "auth-review",
});
```

Delegation is asynchronous by default. `async: false` waits for the result.
`context: "fresh"` is the default; `context: "fork"` preserves the native
conversation, including prior tool results. There is no hidden role prompt,
report-writing suffix, profile selection, or model fallback catalog.

```js
agent_runs({ action: "list" });
agent_runs({ action: "inspect", id: "<run-id>" });
agent_runs({
  action: "continue",
  id: "<run-id>",
  prompt: "Now inspect the refresh-token path. Do not edit.",
});
agent_runs({ action: "wait", id: "<run-id>" });
agent_runs({ action: "stop", id: "<run-id>" });
```

## Talk to agents

```js
intercom({ action: "list" });
intercom({ action: "send", to: "auth-review", message: "Focus on token rotation." });
intercom({ action: "last", to: "auth-review" });
```

`send` steers by default. `last` reads the peer's last completed assistant response
without waking it; large responses are paged, not silently truncated. Discovery
works across project directories and Pi agent directories under the same OS user.

A main and its children form one group:

- Every pair within that group can discover and communicate with each other.
- Main sessions can discover, message, and read other mains.
- Children cannot discover or address another group's agents—even by exact ID.
- Only mains can delegate. There is one child level, not recursive spawning.

These are coordination rules, not an OS sandbox against same-user code. A peer
list contains connected, eligible sessions, not every Pi process on the machine.

## What stays explicit

Launch acceptance is not completion. Broker acceptance is not recipient journal
persistence or a reply. A stop request is not proof of process exit. Saved run
inspection reports these states separately, and does not invent a successful
result when a process disappears.

Children use native Pi sessions and the selected host's SDK, resources, tools,
project instructions, and model configuration. Optional `cwd` and `model`
overrides belong to a launch; ordinary continuation reuses its saved conversation
and launch configuration. No user agent Markdown files are edited or consulted
as profiles.

## Migration and documentation

This rebuild deliberately removes the profile editor, workflow/chain/fanout DSL,
Claude Code backend, custom agent overlays, supervisor-question revival protocol,
and remote launch/control/catalog APIs. Existing installations should finish
in-flight work before switching versions. Keep the prior package and saved state
for rollback; this repository change does not deploy or restart anything.

- [Tools and lifecycle](docs/reference.md)
- [Local messaging and broker migration](docs/intercom.md)
- [Authenticated remote messaging / Grok companion](docs/intercom-bridge.md)
- [Development and qualification](docs/development.md)
- [Diagnosis, baseline, and measurable rebuild gates](docs/single-agent-rebuild.md)

Supports official Pi and the maintained `fitchmultz/pi` fork; the two hosts are
qualified separately. Node.js 24.21 or newer is required. MIT licensed.
