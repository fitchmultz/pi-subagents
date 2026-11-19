import type { IntercomToolParams, ToolResultLike } from "./runtime-types.ts";
export function toolError(
  text: string,
  details: Readonly<Record<string, unknown>> = { error: true },
): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true, details };
}
export function toolText(
  text: string,
  details: Readonly<Record<string, unknown>> = {},
): ToolResultLike {
  return { content: [{ type: "text", text }], isError: false, details };
}
function listingError(params: IntercomToolParams): ToolResultLike | undefined {
  if (params.scope !== undefined && params.action !== "list" && params.action !== "status") {
    return toolError("'scope' is only valid for action='list' or action='status'");
  }
  if (params.children !== undefined && params.action !== "list") {
    return toolError("'children' is only valid for action='list'");
  }
  if (
    params.device !== undefined &&
    (params.action !== "list" || params.scope !== undefined || params.children !== undefined)
  ) {
    return toolError(
      "'device' is only valid for action='list', without 'scope' and 'children': it lists the main sessions of other devices",
    );
  }
  return;
}
export function validateIntercomArguments(params: IntercomToolParams): ToolResultLike | undefined {
  if (
    (params.entryId !== undefined || params.offset !== undefined || params.limit !== undefined) &&
    params.action !== "last"
  ) {
    return toolError("'entryId', 'offset', and 'limit' are only valid for action='last'");
  }
  return listingError(params);
}
export function sendOptions(params: IntercomToolParams): {
  readonly text: string;
  readonly attachments: IntercomToolParams["attachments"];
  readonly replyTo: string | undefined;
  readonly delivery: "steer";
} {
  return {
    text: params.message ?? "",
    attachments: params.attachments,
    replyTo: params.replyTo,
    delivery: "steer",
  };
}
