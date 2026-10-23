// Deterministic content with JSON escapes, line separators, multibyte and astral characters.
const ALPHABET = 'plain "quoted" back\\slash\nnew line \u2028 sep é 雪 😀 tab\t ';
export function observationText(length: number, seed = "t"): string {
  let text = "";
  for (let index = 0; text.length < length; index++) {
    text += `${seed}${index}:${ALPHABET}`;
  }
  text = text.slice(0, length);
  // Never end on a lone high surrogate: native journals would persist an escape, not a pair.
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
export const SIZES = {
  thinking: 20_000,
  text: 1_048_576,
  textGate: 400_000,
  bigArgs: 600 * 1024,
  progress: 50 * 1024,
  progressUpdates: 40,
  growingStep: 128 * 1024,
  growingSteps: 64,
  finalText: 256 * 1024,
  rewrite: 1000,
  /** More tool results than the actor retains settlements for. */
  echoes: 140,
} as const;
