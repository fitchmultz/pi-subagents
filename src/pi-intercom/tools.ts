import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomTransport } from "./transport.ts";
import type { Connection } from "./connection.ts";
import type { IntercomOutbound } from "./outbound.ts";
import type { IntercomTopicActions } from "./topic-actions.ts";
import type { TopicOwner } from "./topics.ts";
import type { IntercomInspection } from "./inspection.ts";
import type { IntercomToolParams, ToolResultLike } from "./runtime-types.ts";
import { validateIntercomArguments, toolError, toolText } from "./tool-arguments.ts";
import { errorMessage } from "./validation.ts";
interface ToolOwners {
  readonly connection: Connection;
  readonly outbound: Readonly<IntercomOutbound>;
  readonly topicActions: Readonly<IntercomTopicActions>;
  readonly topics: TopicOwner;
  readonly inspection: Readonly<IntercomInspection>;
}
export class IntercomTools {
  private readonly owners: ToolOwners;
  constructor(owners: ToolOwners) {
    this.owners = owners;
  }
  private async dispatch(
    active: IntercomTransport,
    params: IntercomToolParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    const scope = params.scope ?? "project";
    switch (params.action) {
      case "subscribe":
      case "unsubscribe":
      case "publish":
      case "topics":
        return await this.owners.topicActions.execute(active, params, ctx);
      case "list":
        return await this.owners.inspection.list(active, scope);
      case "status":
        return await this.owners.inspection.status(active, scope, ctx);
      case "pending":
        return this.owners.inspection.pending();
      case "send":
        return await this.owners.outbound.send(active, params, ctx);
      case "ask":
        return await this.owners.outbound.ask(active, params, signal);
      case "reply":
        return await this.owners.outbound.reply(active, params);
    }
  }
  async execute(
    params: IntercomToolParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    let active: IntercomTransport;
    try {
      active = await this.owners.connection.ensure("tool");
    } catch (error) {
      if (params.action === "topics") {
        this.owners.topics.disconnected();
        return toolText(
          `Broker unavailable; last saved records follow.\n${this.owners.topics.inspect(params.topic)}`,
          { connection: "disconnected" },
        );
      }
      return toolError(`Intercom not connected: ${errorMessage(error)}`);
    }
    this.owners.connection.syncIdentity(ctx.sessionManager.getSessionId());
    if (!["subscribe", "unsubscribe", "publish", "topics"].includes(params.action)) {
      const invalid = validateIntercomArguments(params);
      if (invalid) {
        return invalid;
      }
    }
    return await this.dispatch(active, params, signal, ctx);
  }
}
