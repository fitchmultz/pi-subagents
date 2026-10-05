import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// No filesystem credentials, model catalogue or remote refresh belong to these
// direct-executor tests. The native registry still owns its complete SDK contract.
const modelRegistry = new ModelRegistry(
  await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  }),
);

/** Idle print context for direct executor tests, not a simulated running session. */
export function makeExtensionContext(
  cwd: string,
  overrides: Readonly<Partial<ExtensionContext>> = {},
): ExtensionContext {
  const manager = SessionManager.inMemory(cwd, { id: "session-123" });
  // Preserve the existing fixture's directory hint without claiming file-backed
  // persistence: all entry/tree operations are owned by the in-memory manager.
  manager.getSessionDir = () => cwd;
  const runtime = createExtensionRuntime();
  runtime.getThinkingLevel = () => "off";
  const runner = new ExtensionRunner([], runtime, cwd, manager, modelRegistry);
  runner.setUIContext(undefined, "json");
  return { ...runner.createContext(), ...overrides };
}
