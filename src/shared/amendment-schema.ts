import { Type } from "../agent/typebox.ts";

export const runContractSchema = Type.Object(
  {
    scope: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description:
          "Replace allowed relative edit-tool path prefixes or globs inside cwd, ['*'], or []. Required when adding a contract to a run that had none.",
      }),
    ),
    verification: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description:
          "Replace required verification checks (required when resulting scope is non-empty; pass [] with scope: [] to clear).",
      }),
    ),
    baseBranch: Type.Optional(
      Type.String({
        description: "Replace expected Git base branch or ref (pass '' to clear).",
      }),
    ),
    requiredPrimitives: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Replace required native/package APIs (pass [] to clear).",
      }),
    ),
    nonGoals: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Replace out-of-scope edits or forbidden workarounds (pass [] to clear).",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Omitted fields keep their current values when amending an existing delegation contract.",
  },
);
