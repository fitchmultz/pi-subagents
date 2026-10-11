import { Type, Check } from "../../shared/native-typebox.ts";

const TextList = Type.Array(Type.String());
const TextRecord = Type.Record(Type.String(), Type.String());
export const ToolPrefixSchema = Type.Union([
  Type.Literal("server"),
  Type.Literal("none"),
  Type.Literal("short"),
]);
export const ServerSchema = Type.Object({
  command: Type.Optional(Type.String()),
  args: Type.Optional(TextList),
  socket: Type.Optional(Type.String()),
  env: Type.Optional(TextRecord),
  cwd: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  headers: Type.Optional(TextRecord),
  auth: Type.Optional(
    Type.Union([Type.Literal("oauth"), Type.Literal("bearer"), Type.Literal(false)]),
  ),
  bearerToken: Type.Optional(Type.String()),
  bearerTokenEnv: Type.Optional(Type.String()),
  exposeResources: Type.Optional(Type.Boolean()),
  excludeTools: Type.Optional(TextList),
  includeTools: Type.Optional(TextList),
  toolPrefix: Type.Optional(ToolPrefixSchema),
  disabled: Type.Optional(Type.Boolean()),
});
export const ServersSchema = Type.Record(Type.String(), ServerSchema);
export const CacheSchema = Type.Object({
  version: Type.Literal(1),
  servers: Type.Record(
    Type.String(),
    Type.Object({
      configHash: Type.Optional(Type.String()),
      tools: Type.Optional(Type.Array(Type.Object({ name: Type.Optional(Type.String()) }))),
      resources: Type.Optional(
        Type.Array(
          Type.Object({ uri: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }),
        ),
      ),
      cachedAt: Type.Optional(Type.Number()),
    }),
  ),
});
export { Check };
