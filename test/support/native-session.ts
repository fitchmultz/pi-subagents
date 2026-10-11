import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type Extension,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export interface NativeSessionFixture {
  readonly session: AgentSession;
  readonly pi: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly extensions: readonly Extension[];
  readonly dispose: () => Promise<void>;
}

export interface NativeSessionOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly configure?: ExtensionFactory;
  readonly sessionManager?: SessionManager;
  readonly bindExtensions?: boolean;
}

/** Real registration/dispatch boundary; no synthetic receipts or settled events. */
export async function createNativeSessionFixture(
  options: NativeSessionOptions,
): Promise<NativeSessionFixture> {
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let api: ExtensionAPI | undefined;
  let context: ExtensionContext | undefined;
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Isolated SDK test session.",
    extensionFactories: [
      async (pi) => {
        api = pi;
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
        await options.configure?.(pi);
      },
    ],
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length !== 0) {
    throw new Error(`Fixture extension failed to load: ${JSON.stringify(loadErrors)}`);
  }
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    model: faux.getModel(),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
    noTools: "builtin",
  });
  try {
    if (options.bindExtensions !== false) {
      await session.bindExtensions({ mode: "print" });
    } else {
      // Cold-registration tests own when session_start is dispatched.
      context = session.extensionRunner.createContext();
    }
    if (api === undefined || context === undefined) {
      throw new Error("Native extension registration or session_start did not complete.");
    }
    return {
      session,
      pi: api,
      context,
      extensions: loader.getExtensions().extensions,
      dispose: async () => {
        // This is direct SDK disposal, not an emulation of runtime session_shutdown.
        await session.abort();
        session.dispose();
      },
    };
  } catch (error) {
    session.dispose();
    throw error;
  }
}
