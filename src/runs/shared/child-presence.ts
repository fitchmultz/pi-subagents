/** Distinguish absent/empty fields without primitive truthiness or narrowing known strings. */
export function nonempty(value: string): boolean;
export function nonempty(value: string | null | undefined): value is string;
export function nonempty(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value.length > 0;
}
