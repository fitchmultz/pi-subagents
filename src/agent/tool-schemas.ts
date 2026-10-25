import type { Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "./typebox.ts";

// Main-session tool parameters only; the detached runner must not load pi-ai values.
export const delegateSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact provider/model ID (:thinking and any case need host support); no fuzzy match or fallback.",
      }),
    ),
    context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
  },
  { additionalProperties: false },
);
export type DelegateInput = Static<typeof delegateSchema>;
export const runsSchema = Type.Object(
  {
    action: StringEnum(["list", "inspect", "continue", "stop"] as const),
    id: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    length: Type.Optional(Type.Integer({ minimum: 4, maximum: 262144 })),
  },
  { additionalProperties: false },
);
export type RunsInput = Static<typeof runsSchema>;
