import type { ReadonlyDeep } from "type-fest";

/** Read-only consumer view of application-owned data; does not freeze the live owner. */
export type ReadonlyInput<T> = ReadonlyDeep<T>;
