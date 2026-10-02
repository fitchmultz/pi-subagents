interface FileCoalescer {
	schedule(file: string, delayMs?: number): boolean;
	clear(): void;
}

export function createFileCoalescer(
	handler: (file: string) => void,
	defaultDelayMs: number,
): FileCoalescer {
	const pending = new Map<string, ReturnType<typeof setTimeout>>();

	return {
		schedule(file: string, delayMs = defaultDelayMs): boolean {
			if (pending.has(file)) return false;
			const timer = setTimeout(() => {
				pending.delete(file);
				handler(file);
			}, delayMs);
			pending.set(file, timer);
			return true;
		},
		clear(): void {
			for (const timer of pending.values()) {
				clearTimeout(timer);
			}
			pending.clear();
		},
	};
}
