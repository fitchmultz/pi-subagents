import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomTools } from "./tools.ts";
import type { IntercomSupervisor } from "./supervisor.ts";
import type { ToolResultLike } from "./runtime-types.ts";
import { Type } from "../shared/native-typebox.ts";
import { activateTools } from "../shared/lazy-tools.ts";
import { throwIfToolError } from "./tool-results.ts";
import { intercomSchema, contactSupervisorSchema } from "./tool-schemas.ts";
import {
  renderContactCall,
  renderContactResult,
  renderIntercomCall,
  renderIntercomResult,
} from "./ui/tool-renderers.ts";
type MessagingTool = Readonly<Pick<IntercomTools, "execute">>;
type SupervisorTool = Readonly<Pick<IntercomSupervisor, "execute">>;

function nativeResult(result: ToolResultLike): {
  content: { type: "text"; text: string }[];
  details: Readonly<Record<string, unknown>> | undefined;
  isError: false;
} {
  const success = throwIfToolError(result);
  return { content: [...success.content], details: success.details, isError: false };
}
function registerContact(pi: ExtensionAPI, supervisor: SupervisorTool): void {
  pi.registerTool({
    name: "contact_supervisor",
    label: "Contact Supervisor",
    description:
      "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision only when this child cannot safely continue without a decision, approval, or product/API/scope clarification; this steers the supervisor at its next tool boundary and keeps the child alive for the reply. Use interview_request only when multiple structured answers are all required before safe progress; this also steers and waits. Use progress_update only for a discovery or change the supervisor needs while working; it steers at the next tool boundary without waiting for a reply. Skip starts, redundant status, and routine completion; retain material findings in the final result.",
    promptSnippet:
      "Subagent-only: steer the supervisor for required decisions, structured interviews, or material discoveries needed during active work. Skip routine status and completion messages.",
    promptGuidelines: [
      "Use contact_supervisor with reason='need_decision' when a subagent cannot safely continue without a decision, approval, or product/API/scope clarification; it steers the supervisor and waits for the reply.",
      "Use contact_supervisor with reason='interview_request' only when the child cannot safely continue until it receives multiple structured answers in one blocking steered exchange.",
      "Use contact_supervisor with reason='progress_update' only for a discovery or change the supervisor needs while working. It steers at the next tool boundary without waiting. Skip starts, redundant narration, and routine completion; keep material findings in the final result.",
      "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
    ],
    parameters: contactSupervisorSchema,
    async execute(_id, params, signal, _update, ctx) {
      return nativeResult(await supervisor.execute(params, signal, ctx));
    },
    renderCall: renderContactCall,
    renderResult: renderContactResult,
  });
}
function registerLoader(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "load_intercom",
    label: "Load Intercom",
    description:
      "Enable local peer coordination: list/check sessions before shared-state work, send or reply to messages, and inspect/publish topics. Does not send a message or check peers itself.",
    parameters: Type.Object({}),
    async execute() {
      if (
        !pi.getAllTools().some((tool) => tool.name === "intercom" && tool.namespace === undefined)
      ) {
        throw new Error("Intercom is excluded from this session.");
      }
      activateTools(pi, ["intercom"]);
      return {
        content: [
          {
            type: "text",
            text: "Intercom enabled. Use intercom({action:'list'}) to check peers, or status, pending, reply, send, ask and topics for coordination.",
          },
        ],
        details: {},
      };
    },
  });
}
function registerMessaging(pi: ExtensionAPI, tools: MessagingTool): void {
  pi.registerTool({
    name: "intercom",
    defaultActive: false,
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.
Non-blocking send defaults to steer for guidance, answers, corrections, or blockers that may affect active work. Use queue only when delay is intentional; use ask only when this process must remain alive waiting for the reply.

Usage:
  intercom({ action: "list" })                    → List sessions in this repository and its worktrees
  intercom({ action: "list", scope: "all" })      → List connected sessions across every project
  intercom({ action: "send", to: "session-name", message: "..." })  → Send live coordination (defaults to steer)
  intercom({ action: "ask", to: "session-name", delivery: "steer", message: "..." })   → Blocking wait only when sender must stay alive
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status
  intercom({ action: "subscribe", topic: "project/work", awaitRelease: true }) → Opt into a topic
  intercom({ action: "publish", topic: "project/work", message: "Current self-contained state" }) → Quiet latest state
  intercom({ action: "topics" }) → Inspect topics and current resource owners`,
    promptSnippet:
      "Coordinate with local Pi sessions. Non-blocking send defaults to steer for live agent guidance; queue only for intentional delay and ask only for a required blocking reply.",
    promptGuidelines: [
      "Intercom list/status defaults to the current Git repository and its worktrees. Use scope='all' only when intentionally discovering sessions in other projects.",
      "Action='send' defaults to delivery='steer' for agent-to-agent guidance, answers, corrections, blockers, or other context that may affect active work.",
      "Use delivery='queue' only when delay is intentional. For routine status, explicitly subscribe/publish topics: updates replace quiet inspectable state outside model context, not passive conversation messages. Topic blockers/decisions and awaited ownership releases interrupt; direct messages always bypass subscriptions.",
      "Treat inbound steered messages as supplemental coordination within the active task: incorporate relevant context and continue; replace the task only when the message explicitly says so.",
      "Use action='reply' for an active inbound ask. Otherwise respond with send plus steer; use blocking ask only when this process must stay alive and cannot safely continue without the answer.",
    ],
    parameters: intercomSchema,
    async execute(_id, params, signal, _update, ctx) {
      return nativeResult(await tools.execute(params, signal, ctx));
    },
    renderCall: renderIntercomCall,
    renderResult: renderIntercomResult,
  });
}
export function registerIntercomTools(
  pi: ExtensionAPI,
  tools: MessagingTool,
  supervisor: SupervisorTool | null,
): void {
  if (supervisor) {
    registerContact(pi, supervisor);
  }
  registerLoader(pi);
  registerMessaging(pi, tools);
}
