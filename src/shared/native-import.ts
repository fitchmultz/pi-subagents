import { registerHooks } from "node:module";

/** Resolve only this importing adapter's literal SDK import to the selected host. */
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
