import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export function setPromptSection(
  options: NormalizedBuildSystemPromptOptions,
  name: string,
  content: string,
): void {
  // Pi owns this mutable prompt-building options object. This SDK hook updates
  // sections and its legacy exact override in place; callers observe the same object.
  options.sections[name] = content;
  // Pi projects an earlier exact override instead of sections. Preserve its content;
  // this compatibility path replaces the leading prompt and cannot preserve its cache prefix.
  if (options.forceSystemPrompt !== undefined) {
    options.forceSystemPrompt += `\n\n<${name}>\n${content}\n</${name}>`;
  }
}
