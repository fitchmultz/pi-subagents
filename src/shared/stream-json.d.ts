import type { Many, none } from "stream-chain/defs.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

// stream-json 3.7.0 exports the synchronous tokenizer used by its default
// generator adapter, but omits this export from parser.d.ts.
declare module "stream-json/core/parser.js" {
  export function jsonParser(
    options?: Readonly<ParserOptions>,
  ): (chunk: string | typeof none) => Many<Token> | typeof none;
}
