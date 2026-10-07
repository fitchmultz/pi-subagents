import { registerHooks } from "node:module";

/** Resolve only this native Node importer's literal SDK import to the selected host. */
// ponytail: Jiti rewrites callback imports and loses their originating parent URL.
// Jiti adapters must use the approved declaration-typed selected URL import boundary.
export async function importSelectedNative<T>(
  parentURL: string,
  specifier: string,
  targetURL: string,
  load: () => Promise<T>,
): Promise<T> {
  const hooks = registerHooks({
    resolve(request, context, nextResolve) {
      if (request === specifier && context.parentURL === parentURL) {
        return nextResolve(targetURL, context);
      }
      return nextResolve(request, context);
    },
  });
  try {
    return await load();
  } finally {
    hooks.deregister();
  }
}
