import * as path from "node:path";

export function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const packageName = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;
	return packageName.length > 0
		&& !path.isAbsolute(packageName)
		&& packageName.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..")
		? packageName
		: undefined;
}
