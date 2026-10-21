import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomTransport } from "./transport.ts";
import { resolveConnectedTarget, type IntercomConnection } from "./connection.ts";
import type { IntercomOutbound } from "./outbound.ts";
import type { IntercomInspection } from "./inspection.ts";
import type { IntercomToolParams, ToolResultLike } from "./runtime-types.ts";
import { validateIntercomArguments, toolError } from "./tool-arguments.ts";
import { errorMessage } from "./validation.ts";
import type { LastMessageResult } from "./types.ts";

function lastPage(result: Exclude<LastMessageResult, { readonly error: string }>): ToolResultLike {
  const identity = `${result.session.name ?? result.session.id} (${result.session.id})`;
  const page =
    result.entryId === null
      ? "No completed assistant response."
      : `Entry: ${result.entryId}\nCharacters (UTF-16): ${result.offset}–${result.offset + result.text.length} of ${result.totalLength}`;
  const next =
    result.nextOffset === undefined
      ? ""
      : `\nNext page: intercom(${JSON.stringify({ action: "last", to: result.session.id, entryId: result.entryId, offset: result.nextOffset })})`;
  return {
    content: [
      { type: "text", text: result.text },
      {
        type: "text",
        text: `Session: ${identity}\nStatus: ${result.session.status ?? "unknown"}\n${page}${next}`,
      },
    ],
    details: { ...result },
  };
}

interface ToolOwners {
  readonly connection: Readonly<Pick<IntercomConnection, "ensure" | "syncIdentity">>;
  readonly outbound: Readonly<Pick<IntercomOutbound, "send" | "ask" | "reply">>;
  readonly inspection: Readonly<Pick<IntercomInspection, "list" | "status" | "pending">>;
}
export class IntercomTools {
  private readonly owners: ToolOwners;
  constructor(owners: ToolOwners) {
    this.owners = owners;
  }
  async execute(
    params: IntercomToolParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResultLike> {
    const invalid = validateIntercomArguments(params);
    if (invalid) {
      return invalid;
    }
    let active: IntercomTransport;
    try {
      active = await this.owners.connection.ensure();
    } catch (error) {
      return toolError(`Intercom not connected: ${errorMessage(error)}`);
    }
    this.owners.connection.syncIdentity(ctx.sessionManager.getSessionId());
    const scope = params.scope ?? "all";
    switch (params.action) {
      case "list":
        return await this.owners.inspection.list(active, scope);
      case "status":
        return await this.owners.inspection.status(active, scope, ctx);
      case "pending":
        return this.owners.inspection.pending();
      case "last": {
        if (params.to === undefined || params.to === "") {
          return toolError("Missing 'to' parameter");
        }
        try {
          const target = (await resolveConnectedTarget(active, params.to)) ?? params.to;
          const result = await active.last(target, {
            entryId: params.entryId,
            offset: params.offset,
            limit: params.limit,
          });
          if ("error" in result) {
            return toolError(result.error);
          }
          return lastPage(result);
        } catch (error) {
          return toolError(`Failed to read last response: ${errorMessage(error)}`);
        }
      }
      case "send":
        return await this.owners.outbound.send(active, params, ctx);
      case "ask":
        return await this.owners.outbound.ask(active, params, signal);
      case "reply":
        return await this.owners.outbound.reply(active, params);
    }
  }
}
