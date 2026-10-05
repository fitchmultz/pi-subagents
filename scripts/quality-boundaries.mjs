// Real mutation owners authorized by the policy, not readonly permission for their readers.
export const mutationBoundaries = [
  ...["pi-intercom-runtime", "pi-intercom-native-replay"].map((suite) => ({
    file: `test/integration/${suite}.test.ts`,
    parameters: [],
    types: [{ from: "file", path: "./src/pi-intercom/broker/client.ts", name: ["IntercomClient"] }],
    contract:
      "Native broker lifecycle tests own the actual RPC connection and subscription handle, not arbitrary client-shaped data.",
  })),
  ...[
    ["task-store", ["AgentTask", "AgentVisit"]],
    ["view-session", ["AgentVisit"]],
    ["agent-browser", ["AgentTaskStore", "ViewSession"]],
    ["agent-controls", ["AgentTaskStore", "ViewSession"]],
    ["agent-view", ["OpenAgentsRequest"]],
    ["conversation-viewport", ["HistoryCards"]],
    ["conversation-selection", ["HistoryCards"]],
    ["agent-picker", ["PickerController"]],
    ["agent-conversation", ["ConversationController"]],
    ["conversation-history", ["ConversationController"]],
  ].map(([owner, names]) => ({
    file: `src/tui/${owner}.ts`,
    parameters: { "task-store": ["task"], "agent-view": ["request"] }[owner] ?? [],
    types: names.map((name) => {
      const origins = {
        AgentTask: "view-model",
        AgentVisit: "view-model",
        AgentTaskStore: "task-store",
        ViewSession: "view-session",
        OpenAgentsRequest: "agent-view",
        HistoryCards: "history-cards",
        PickerController: "view-ports",
        ConversationController: "view-ports",
      };
      return { from: "file", path: `./src/tui/${origins[name]}.ts`, name: [name] };
    }),
    contract:
      "The native view boundary owns commands, drafts, caches and UI lifetime; pure display data uses readonly inputs.",
  })),
  ...["task-store", "view-session", "agent-browser", "agent-view"].map((owner) => ({
    file: `src/tui/${owner}.ts`,
    parameters: [],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract: "The view lifecycle passes actual supervisor state to its owning operations.",
  })),

  {
    file: "src/runs/shared/run-state-owner.ts",
    parameters: ["state"],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract: "The run-state owner creates, removes and settles entries in the supervisor state.",
  },
  ...[
    "run-restoration",
    "run-persistence",
    "history-index",
    "run-history-queries",
    "owned-run-list",
  ].map((owner) => ({
    file: `src/runs/shared/${owner}.ts`,
    parameters: owner === "history-index" ? ["state"] : [],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract:
      "This lifecycle gateway passes actual state to restoration, publication or cache readiness owners; pure readers use readonly views.",
  })),
  {
    file: "src/runs/foreground/question-control.ts",
    parameters: [],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract: "Question control revives actual saved subagents through the focused state owner.",
  },
  {
    file: "src/runs/shared/nested-projection.ts",
    parameters: ["job"],
    types: [
      { from: "file", path: "./src/shared/types/async.ts", name: ["AsyncJobState"] },
      {
        from: "file",
        path: "./src/runs/shared/nested-projection.ts",
        name: ["MutableStepProjection"],
      },
    ],
    contract: "Nested projection updates owned jobs and attaches children to actual step objects.",
  },
  {
    file: "src/runs/shared/native-usage.ts",
    parameters: ["usage"],
    types: [{ from: "file", path: "./src/shared/types/usage.ts", name: ["UsageAccumulator"] }],
    contract: "addUsage mutates the owning usage accumulator rather than replacing its identity.",
  },
  ...[
    ["runner-status", ["RunnerStatusStep", "RunnerStatusPayload"], ["step", "statusPayload"]],
    ["runner-child-observer", ["RunnerStatusPayload"], []],
    ["runner-monitor", ["RunnerStatusPayload"], []],
    ["runner-dynamic", ["RunnerStatusPayload"], ["statusPayload"]],
    ["runner-lifecycle", ["RunnerStatusPayload", "RunnerMonitor"], []],
    ["runner-child-executor", ["RunnerMonitor", "RunnerLifecycle"], []],
    ["runner-finalization", ["RunnerAttempt"], []],
    ["runner-parallel", ["RunnerMonitor", "RunnerLifecycle", "RunnerChildExecutor"], []],
    ["runner-workflow", ["RunnerMonitor", "RunnerLifecycle"], []],
    ["runner-completion", ["RunnerMonitor", "RunnerLifecycle"], []],
  ].map(([owner, names, parameters]) => ({
    file: `src/runs/background/${owner}.ts`,
    parameters,
    types: names.map((name) => {
      const origins = {
        RunnerStatusStep: "runner-status",
        RunnerStatusPayload: "runner-status",
        RunnerMonitor: "runner-monitor",
        RunnerLifecycle: "runner-lifecycle",
        RunnerChildExecutor: "runner-child-executor",
        RunnerAttempt: "runner-attempt",
      };
      return { from: "file", path: `./src/runs/background/${origins[name]}.ts`, name: [name] };
    }),
    contract:
      "This detached execution phase commands the actual runner lifecycle or live status owner; workflow inputs, results and observation data remain readonly.",
    argumentPresence:
      owner === "runner-child-executor"
        ? "register(index, undefined) clears the active child interrupt callback."
        : undefined,
  })),
  {
    file: "src/runs/background/runner-step-output.ts",
    parameters: [],
    types: [],
    contract: "The step output boundary retains the cleanup API's required positional baseline.",
    argumentPresence:
      "cleanupSingleOutputFile requires its third baseline argument, including undefined.",
  },
  {
    file: "src/runs/shared/worktree-preservation.ts",
    parameters: ["setup"],
    types: [
      { from: "file", path: "./src/runs/shared/worktree-contract.ts", name: ["WorktreeSetup"] },
    ],
    contract: "Worktree preservation records the retained directory on the owning setup handle.",
  },
  {
    file: "src/runs/foreground/wait-registration.ts",
    parameters: ["state"],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract: "Wait registration owns increments, decrements and initial creation of waitingRuns.",
  },
  {
    file: "src/extension/control-notices.ts",
    parameters: [],
    types: [
      {
        from: "file",
        path: "./src/extension/control-notices.ts",
        name: ["ControlNoticeDeliveryInput"],
      },
    ],
    contract:
      "Control notice delivery owns the deduplication store while its other data and SDK inputs retain readonly contracts.",
  },
  {
    file: "src/runs/shared/control-notification-owner.ts",
    parameters: [],
    types: [{ from: "lib", name: ["Set"] }],
    contract:
      "The focused notification claim owner updates only caller-owned Set<string> deduplication keys.",
  },
  {
    file: "test/integration/agent-interaction.test.ts",
    parameters: [],
    types: [
      { from: "file", path: "./test/integration/agent-interaction.test.ts", name: ["Fixture"] },
    ],
    contract:
      "The native interaction fixture owns actual controller, session, state maps and TUI lifetimes; pure display inputs remain readonly.",
  },
  {
    file: "src/shared/prompt-sections.ts",
    parameters: ["options"],
    types: [
      {
        from: "package",
        package: "@earendil-works/pi-coding-agent",
        name: ["NormalizedBuildSystemPromptOptions"],
      },
    ],
    contract: "The prompt-section adapter edits the SDK draft supplied for prompt construction.",
  },
  ...["async-job-tracker", "result-watcher", "completion-delivery"].map((owner) => ({
    file: `src/runs/background/${owner}.ts`,
    parameters: ["state"],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract:
      "This lifecycle owner captures and updates actual supervisor state, not a read-only snapshot.",
  })),
  {
    file: "src/runs/background/async-job-projection.ts",
    parameters: ["job"],
    types: [{ from: "file", path: "./src/shared/types/async.ts", name: ["AsyncJobState"] }],
    contract: "The per-job projection owner retains and updates its actual job instance.",
  },
  {
    file: "src/runs/background/completion-dedupe.ts",
    parameters: [],
    types: [
      {
        from: "file",
        path: "./src/runs/background/completion-dedupe.ts",
        name: ["CompletionSeenStore"],
      },
    ],
    contract:
      "Completion deduplication owns method-based edits to its named seen store, not generic Map inputs.",
  },
  {
    file: "src/runs/foreground/wait-run.ts",
    parameters: [],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract:
      "The public wait gateway passes the actual state to the focused wait-registration owner.",
  },
  {
    file: "test/unit/execution-cwd.test.ts",
    parameters: ["request"],
    types: [],
    contract:
      "Native resolve-execution-cwd listeners must synchronously place the response on their bus request.",
  },
  {
    file: "test/fixtures/native-execution-cwd-owner.ts",
    parameters: ["event", "request"],
    types: [],
    contract:
      "The native sandbox adapter sets SDK event cwd/path and directory-bus results before dispatch.",
  },
  {
    file: "test/fixtures/native-cwd-delegation.mjs",
    parameters: ["request"],
    types: [],
    contract:
      "The native resolve-execution-cwd listener synchronously writes its directory response to the caller's request.result before launch.",
  },
  ...["foreground-control", "question-continuation", "saved-revival"].map((owner) => ({
    file: `src/runs/foreground/${owner}.ts`,
    parameters: [],
    types: [
      { from: "file", path: "./src/runs/foreground/saved-revival.ts", name: ["RevivalInput"] },
    ],
    contract:
      "Continuation and revival command the actual session-owned launch and durable receipt state.",
  })),
  ...["invocation-execution", "management-actions", "subagent-executor"].map((owner) => ({
    file: `src/runs/foreground/${owner}.ts`,
    parameters: [],
    types: [
      { from: "file", path: "./src/runs/foreground/subagent-params.ts", name: ["ExecutorDeps"] },
    ],
    contract:
      "The foreground launch/control gateway commands actual executor session state; readonly readers use ExecutorReadDeps.",
  })),
  ...["run-interrupt", "saved-revival"].map((owner) => ({
    file: `src/runs/foreground/${owner}.ts`,
    parameters: [],
    types: [{ from: "file", path: "./src/shared/types/state.ts", name: ["SubagentState"] }],
    contract:
      "Stop and revival persist actual tracked job or run records through the focused state owner.",
  })),
  ...["agent-browser", "indexed-history"].map((owner) => ({
    file: `src/tui/${owner}.ts`,
    parameters: [],
    types: [{ from: "file", path: "./src/shared/types/history.ts", name: ["HistoryIndexHandle"] }],
    contract:
      "The native history capability owns worker requests, refresh and subscriptions; TUI gateways retain stale-result guards and dispose subscriptions.",
  })),
  {
    file: "src/tui/view-connections.ts",
    parameters: [],
    types: [
      { from: "file", path: "./src/tui/task-store.ts", name: ["AgentTaskStore"] },
      { from: "file", path: "./src/tui/agent-browser.ts", name: ["AgentBrowser"] },
      { from: "file", path: "./src/tui/agent-controls.ts", name: ["AgentControls"] },
    ],
    contract:
      "The native connection owner binds live task/cache, browsing and control handles; data and ports retain readonly inputs.",
  },
  {
    file: "test/fixtures/native-legacy-completion.mjs",
    parameters: ["pi"],
    types: [],
    contract:
      "The native SDK factory instruments sendMessage on its actual Pi instance; receipt and delivery behavior remain SDK-owned.",
  },
  {
    file: "test/fixtures/native-tool-results.mjs",
    parameters: ["receipt"],
    types: [],
    contract:
      "The native observation fixture fills its caller-owned receipt from actual SDK publications and rendered tool results.",
  },
  {
    file: "test/integration/doctor-executor.test.ts",
    parameters: ["request"],
    types: [],
    contract:
      "The native resolve-execution-cwd callback synchronously writes request.result before the doctor launches its subprocess.",
  },
];

export function boundaryOverrides(config) {
  const grouped = new Map();
  for (const boundary of mutationBoundaries) {
    const current = grouped.get(boundary.file) ?? { ...boundary, parameters: [], types: [] };
    current.parameters = [...new Set([...current.parameters, ...boundary.parameters])];
    current.types.push(...boundary.types);
    grouped.set(boundary.file, current);
  }
  const readonly = config.rules["typescript/prefer-readonly-parameter-types"][1];
  return [...grouped.values()].map((boundary) => ({
    files: [boundary.file],
    rules: {
      "no-param-reassign": [
        "error",
        { props: true, ignorePropertyModificationsFor: boundary.parameters },
      ],
      "typescript/prefer-readonly-parameter-types": [
        "error",
        { ...readonly, allow: [...readonly.allow, ...boundary.types] },
      ],
      ...(boundary.argumentPresence === undefined
        ? {}
        : { "unicorn/no-useless-undefined": ["error", { checkArguments: false }] }),
    },
  }));
}
