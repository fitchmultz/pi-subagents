import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	applyIntercomBridgeToAgent,
	INTERCOM_BRIDGE_MARKER,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveOrchestratorIntercomTarget,
	resolveSubagentIntercomTarget,
	type IntercomBridgeState,
} from "../../src/intercom/intercom-bridge.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Test worker",
		systemPrompt: "Base prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

const bridge: IntercomBridgeState = {
	orchestratorTarget: "main",
	instruction: `${INTERCOM_BRIDGE_MARKER}\n- Need a decision or blocked: contact_supervisor({ reason: "need_decision", message: "<question>" })\n- Blocked/update: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })`,
};

describe("resolveIntercomSessionTarget", () => {
	it("prefers an explicit session name", () => {
		assert.equal(resolveIntercomSessionTarget("planner", "session-12345678"), "planner");
	});

	it("uses a runtime-only subagent chat alias when unnamed", () => {
		assert.equal(resolveIntercomSessionTarget(undefined, "session-12345678"), "subagent-chat-12345678");
	});
});

describe("resolveOrchestratorIntercomTarget", () => {
	it("uses an exact connected identity and immediately falls back when unavailable", () => {
		const listeners = new Map<string, (payload: unknown) => void>();
		const events = {
			on(channel: string, handler: (payload: unknown) => void) {
				listeners.set(channel, handler);
				return () => listeners.delete(channel);
			},
			emit(channel: string, payload: unknown) {
				if (channel === "subagent:intercom-identity-request") {
					const requestId = (payload as { requestId: string }).requestId;
					listeners.get("subagent:intercom-identity-response")?.({ requestId, sessionId: "exact-broker-session" });
				}
			},
		};
		assert.equal(resolveOrchestratorIntercomTarget(events, "duplicate-name"), "exact-broker-session");
		events.emit = () => {};
		assert.equal(resolveOrchestratorIntercomTarget(events, "duplicate-name"), "duplicate-name");
		assert.equal(listeners.size, 0);
	});

	for (const failure of ["listener", "emit", "unsubscribe"] as const) {
		it(`falls back without leaking when ${failure} throws`, () => {
			const listeners = new Set<(payload: unknown) => void>();
			const events = {
				on(_channel: string, handler: (payload: unknown) => void) {
					if (failure === "listener") throw new Error("listener failed");
					listeners.add(handler);
					return () => {
						listeners.delete(handler);
						if (failure === "unsubscribe") throw new Error("unsubscribe failed");
					};
				},
				emit() {
					if (failure === "emit") throw new Error("emit failed");
				},
			};
			assert.equal(resolveOrchestratorIntercomTarget(events, "fallback"), "fallback");
			assert.equal(listeners.size, 0);
		});
	}
});

describe("resolveSubagentIntercomTarget", () => {
	it("builds deterministic child targets", () => {
		assert.equal(resolveSubagentIntercomTarget("abcd1234", "Worker Agent", 0), "subagent-worker-agent-abcd1234-1");
		assert.equal(resolveSubagentIntercomTarget("abcd1234", "Worker Agent"), "subagent-worker-agent-abcd1234");
	});
});

describe("resolveIntercomBridge", () => {
	it("preserves the exact default paired-path instructions", () => {
		const bridge = resolveIntercomBridge("main");
		assert.equal(bridge.orchestratorTarget, "main");
		assert.equal(bridge.instruction, `Intercom orchestration channel:
The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the supervisor in normal assistant text.

Use contact_supervisor first. It resolves the supervisor session "main" and run metadata automatically.
- If you cannot safely continue without one decision, approval, or product/API/scope clarification: contact_supervisor({ reason: "need_decision", message: "<question>" }). It steers the supervisor and keeps this ephemeral child alive for the reply.
- If you cannot safely continue until the supervisor provides multiple structured answers: contact_supervisor({ reason: "interview_request", message: "<context>", interview: { questions: [{ id: "<id>", type: "text", question: "<question>" }] } }). It also steers and keeps this child alive.
- After blocking contact_supervisor decisions or interviews, continue only after the reply arrives. Do not finish your final response with a choose-one question.
- Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions. Review-only/no-edit wins; leave files unchanged and mention the conflict in your final result only if it matters.
- A concise material update that may intentionally wait behind the supervisor's active work: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })
- Generic intercom is lower-level fallback only. Use blocking intercom({ action: "ask", to: "main", delivery: "steer", message: "<question>" }) only when this child must remain alive for the answer.
- Treat a supervisor nudge as supplemental coordination within the active task: incorporate relevant context and continue. Replace the task only when the nudge explicitly says so. If it requests an answer, respond with intercom({ action: "send", to: "main", delivery: "steer", message: "<answer>" }).

Do not use contact_supervisor or intercom for routine completion handoffs. If no coordination is needed, return a focused task result.`);
	});
});

describe("applyIntercomBridgeToAgent", () => {
	it("injects intercom tool and prompt instructions", () => {
		const updated = applyIntercomBridgeToAgent(makeAgent({ tools: ["read", "bash"] }), bridge);
		assert.deepEqual(updated.tools, ["read", "bash", "intercom", "contact_supervisor"]);
		assert.match(updated.systemPrompt, /Intercom orchestration channel:/);
		assert.match(updated.systemPrompt, /contact_supervisor/);
	});

	it("is idempotent", () => {
		const first = applyIntercomBridgeToAgent(makeAgent({ tools: ["read"] }), bridge);
		const second = applyIntercomBridgeToAgent(first, bridge);
		assert.equal(second.tools?.filter((tool) => tool === "intercom").length, 1);
		assert.equal(second.tools?.filter((tool) => tool === "contact_supervisor").length, 1);
		assert.equal(second.systemPrompt, first.systemPrompt);
	});

	it("leaves tools undefined when the agent had no explicit tool list", () => {
		const agent = makeAgent({ tools: undefined });
		const updated = applyIntercomBridgeToAgent(agent, bridge);
		assert.equal(updated.tools, undefined);
		assert.match(updated.systemPrompt, /Intercom orchestration channel:/);
	});

	it("replaces standalone intercom allowlist entries with the bundled extension", () => {
		for (const extensions of [["pi-intercom"], ["/tmp/extensions/pi-intercom/index.ts"], ["C:\\\\Users\\\\x\\\\pi-intercom"]]) {
			const updated = applyIntercomBridgeToAgent(makeAgent({ tools: ["read"], extensions }), bridge);
			assert.deepEqual(updated.tools, ["read", "intercom", "contact_supervisor"], extensions.join(","));
			assert.equal(updated.extensions?.length, 1);
			assert.match(updated.extensions?.[0]?.replaceAll("\\\\", "/") ?? "", /\/src\/pi-intercom\/index\.ts$/);
			assert.notEqual(updated.extensions?.[0], extensions[0]);
		}
	});

	it("is idempotent after resolving the bundled extension", () => {
		const first = applyIntercomBridgeToAgent(makeAgent({ tools: ["read"], extensions: ["pi-intercom"] }), bridge);
		assert.equal(applyIntercomBridgeToAgent(first, bridge), first);
	});

	it("deduplicates bundled intercom while preserving unrelated allowlist entries", () => {
		const updated = applyIntercomBridgeToAgent(makeAgent({
			tools: ["read"],
			extensions: ["/tmp/other-extension/index.ts", "pi-intercom", "/old/pi-intercom/index.ts"],
		}), bridge);

		assert.equal(updated.extensions?.length, 2);
		assert.equal(updated.extensions?.[0], "/tmp/other-extension/index.ts");
		assert.match(updated.extensions?.[1]?.replaceAll("\\\\", "/") ?? "", /\/src\/pi-intercom\/index\.ts$/);
	});

	it("does not inject when extension sandbox excludes intercom", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/other-extension/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, bridge);
		assert.equal(updated, agent);
	});

	it("does not inject for empty allowlists", () => {
		const agent = makeAgent({ tools: ["read"], extensions: [] });
		assert.equal(applyIntercomBridgeToAgent(agent, bridge), agent);
	});

	it("does not treat not-pi-intercom paths as allowed", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/not-pi-intercom/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, bridge);
		assert.equal(updated, agent);
	});
});
