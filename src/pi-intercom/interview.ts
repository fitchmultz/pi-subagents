import { errorMessage, isRecord, isUnknownArray } from "./validation.ts";

export type InterviewType = "single" | "multi" | "text" | "image" | "info";
export type InterviewOption =
  | string
  | (Readonly<Record<string, unknown>> & { readonly label: string });
export interface SupervisorInterviewQuestion extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly type: InterviewType;
  readonly question: string;
  readonly options?: readonly InterviewOption[];
}
export interface SupervisorInterviewRequest extends Readonly<Record<string, unknown>> {
  readonly title?: string;
  readonly description?: string;
  readonly questions: readonly SupervisorInterviewQuestion[];
}
export interface SupervisorInterviewReply {
  readonly responses: readonly { readonly id: string; readonly value: unknown }[];
}
function interviewType(value: unknown): value is InterviewType {
  return (
    value === "single" ||
    value === "multi" ||
    value === "text" ||
    value === "image" ||
    value === "info"
  );
}
function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}
function optionValue(value: unknown, field: string): InterviewOption {
  if (typeof value === "string") {
    const label = value.trim();
    if (label === "") {
      throw new Error(`${field} must not be empty`);
    }
    return label;
  }
  if (!isRecord(value) || typeof value.label !== "string" || value.label.trim() === "") {
    throw new Error(`${field} must be a non-empty string or an object with a non-empty label`);
  }
  return { ...value, label: value.label.trim() };
}
function parseOptions(
  raw: Readonly<Record<string, unknown>>,
  field: string,
  type: InterviewType,
): readonly InterviewOption[] | undefined {
  if (raw.options === undefined) {
    if (type === "single" || type === "multi") {
      throw new Error(`${field}.options must be a non-empty array for ${type} questions`);
    }
    return;
  }
  if (!isUnknownArray(raw.options)) {
    throw new Error(`${field}.options must be an array when provided`);
  }
  const options = raw.options.map((option, index) =>
    optionValue(option, `${field}.options[${index}]`),
  );
  if (type !== "single" && type !== "multi") {
    throw new Error(`${field}.options is only valid for single and multi questions`);
  }
  if (options.length === 0) {
    throw new Error(`${field}.options must be a non-empty array for ${type} questions`);
  }
  return options;
}
function parseQuestion(value: unknown, index: number): SupervisorInterviewQuestion {
  const field = `interview.questions[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const id = nonempty(value.id, `${field}.id`);
  if (!interviewType(value.type)) {
    throw new Error(`${field}.type must be one of: single, multi, text, image, info`);
  }
  const question = nonempty(value.question, `${field}.question`);
  if (value.context !== undefined && typeof value.context !== "string") {
    throw new Error(`${field}.context must be a string when provided`);
  }
  const options = parseOptions(value, field, value.type);
  return { ...value, id, type: value.type, question, ...(options ? { options } : {}) };
}
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
  return value.trim();
}
function parseInterview(input: unknown): SupervisorInterviewRequest {
  if (!isRecord(input)) {
    throw new Error("interview must be an object with a questions array");
  }
  const title = optionalText(input.title, "interview.title");
  const description = optionalText(input.description, "interview.description");
  if (!isUnknownArray(input.questions) || input.questions.length === 0) {
    throw new Error("interview.questions must be a non-empty array");
  }
  const ids = new Set<string>();
  const questions = input.questions.map((value, index) => {
    const question = parseQuestion(value, index);
    if (ids.has(question.id)) {
      throw new Error(`interview question id must be unique: ${question.id}`);
    }
    ids.add(question.id);
    return question;
  });
  return {
    ...input,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    questions,
  };
}
export function validateSupervisorInterviewRequest(
  input: unknown,
):
  | { readonly ok: true; readonly interview: SupervisorInterviewRequest }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, interview: parseInterview(input) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
function optionLabel(option: InterviewOption): string {
  return typeof option === "string" ? option : option.label;
}
function exampleValue(question: SupervisorInterviewQuestion): unknown {
  switch (question.type) {
    case "multi":
      return question.options?.slice(0, 2).map(optionLabel) ?? [];
    case "single": {
      const first = question.options?.[0];
      return first === undefined ? "option label" : optionLabel(first);
    }
    case "image":
      return "image/file reference or description";
    case "info":
    case "text":
      return "answer text";
  }
}
function interviewPreamble(
  interview: SupervisorInterviewRequest,
  message: string | undefined,
): string[] {
  const lines = [
    ["Interview", interview.title],
    ["", interview.description],
    ["Child note", message],
  ].flatMap(([label, value]) => {
    const text = value?.trim() ?? "";
    if (text === "") {
      return [];
    }
    return [label === "" ? text : `${label ?? ""}: ${text}`];
  });
  if (lines.length > 0) {
    lines.push("");
  }
  return lines;
}
export function formatSupervisorInterviewRequest(
  interview: SupervisorInterviewRequest,
  message?: string,
): string {
  const lines = interviewPreamble(interview, message);
  lines.push("Questions:");
  interview.questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.id}] (${question.type}) ${question.question}`);
    if (typeof question.context === "string" && question.context.trim() !== "") {
      lines.push(`   Context: ${question.context.trim()}`);
    }
    if (question.options !== undefined && question.options.length > 0) {
      lines.push("   Options:");
      for (const option of question.options) {
        lines.push(`   - ${optionLabel(option)}`);
      }
    }
  });
  const responseExample = {
    responses: interview.questions
      .filter((question) => question.type !== "info")
      .map((question) => ({ id: question.id, value: exampleValue(question) })),
  };
  lines.push(
    "",
    "Supervisor reply instructions:",
    "Reply with plain JSON or a fenced ```json block using this stable shape. Use the question ids exactly. Info questions are context-only and do not need responses. For single questions, value is one option label. For multi questions, value is an array of option labels. For text/image questions, value is a string unless the question asks otherwise.",
    "",
    "```json",
    JSON.stringify(responseExample, null, 2),
    "```",
  );
  return lines.join("\n");
}
function multiResponse(
  value: unknown,
  question: SupervisorInterviewQuestion,
  field: string,
): readonly string[] {
  if (!isUnknownArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings for multi questions`);
  }
  const labels = new Set(question.options?.map(optionLabel));
  const selected = value.map((item) => item.trim());
  const invalid = selected.find((item) => !labels.has(item));
  if (invalid !== undefined && invalid !== "") {
    throw new Error(`${field} contains an option that is not in the question options: ${invalid}`);
  }
  return selected;
}
function responseValue(
  value: unknown,
  question: SupervisorInterviewQuestion,
  index: number,
): unknown {
  const field = `responses[${index}].value`;
  if (question.type === "multi") {
    return multiResponse(value, question, field);
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string for ${question.type} questions`);
  }
  if (question.type !== "single") {
    return value;
  }
  const labels = new Set(question.options?.map(optionLabel));
  if (!labels.has(value.trim())) {
    throw new Error(`${field} must match one of the question options`);
  }
  return value.trim();
}
function validateReply(
  value: unknown,
  interview: SupervisorInterviewRequest,
): SupervisorInterviewReply {
  if (!isRecord(value)) {
    throw new Error("reply JSON must be an object with a responses array");
  }
  if (!isUnknownArray(value.responses)) {
    throw new Error("reply JSON must include a responses array");
  }
  const byId = new Map(
    interview.questions
      .filter((question) => question.type !== "info")
      .map((question) => [question.id, question]),
  );
  const seen = new Set<string>();
  const responses = value.responses.map((response, index) => {
    if (!isRecord(response)) {
      throw new Error(`responses[${index}] must be an object`);
    }
    const id = nonempty(response.id, `responses[${index}].id`);
    const question = byId.get(id);
    if (!question) {
      throw new Error(`responses[${index}].id must match a non-info interview question id`);
    }
    if (seen.has(id)) {
      throw new Error(`responses[${index}].id is duplicated: ${id}`);
    }
    seen.add(id);
    if (!Object.hasOwn(response, "value")) {
      throw new Error(`responses[${index}].value is required`);
    }
    return { id, value: responseValue(response.value, question, index) };
  });
  return { responses };
}
export function parseStructuredSupervisorReply(
  text: string,
  interview: SupervisorInterviewRequest,
): { readonly value?: SupervisorInterviewReply; readonly error?: string } | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return;
  }
  try {
    const value: unknown = JSON.parse(candidate);
    return { value: validateReply(value, interview) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
