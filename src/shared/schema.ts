import {
  compile,
  unsafe,
  Validator,
  type Annotations,
  type Schema,
  type ValidationError,
} from "@earendil-works/pi-schema";

const compiled = new WeakMap<object, Validator>();

function validatorFor(schema: object): Validator {
  let validator = compiled.get(schema);
  if (validator === undefined) {
    validator = compile(schema);
    compiled.set(schema, validator);
  }
  return validator;
}

/** Formats pi-schema validation errors with JSON Pointer paths. */
export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((error) => `${error.path === "" ? "/" : error.path}: ${error.message}`)
    .join("; ");
}

/** Validates `value` against a pi-schema `Schema` (cached per schema) or precompiled `Validator`. */
export function assertValid<T>(
  schema: Schema<T> | Validator<T>,
  value: unknown,
): asserts value is T {
  const validator = schema instanceof Validator ? schema : validatorFor(schema);
  const result = validator.validate(value);
  if (!result.ok) {
    throw new Error(`Invalid schema value: ${formatValidationErrors(result.errors)}`);
  }
}

/**
 * Emits `{ type: "string", enum: [...] }` for LLM tool schemas (Google, OpenAI strict mode,
 * Anthropic) without importing `@earendil-works/pi-ai` at runtime in detached child processes.
 */
export function stringEnum<const V extends readonly string[]>(
  values: V,
  options?: Annotations<V[number]>,
): Schema<V[number]> {
  return unsafe<V[number]>({ type: "string", enum: values, ...options });
}
