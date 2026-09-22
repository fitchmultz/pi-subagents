import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export function setPromptSection(options: NormalizedBuildSystemPromptOptions, name: string, content: string): void {
	options.sections[name] = content;
	// Pi projects an earlier exact override instead of sections. Preserve its content;
	// this compatibility path replaces the leading prompt and cannot preserve its cache prefix.
	if (options.forceSystemPrompt !== undefined) {
		options.forceSystemPrompt += `\n\n<${name}>\n${content}\n</${name}>`;
	}
}
