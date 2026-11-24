import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";

const NON_ANSWER_ASK_QUESTION =
  /(?:\bcurrently AFK\b|A timeout does not answer|\buser cancelled\b|^cancelled\b)/iu;

interface AskQuestionAnswer {
  readonly question: string;
  readonly answer: string;
}

/** Chronological owner conversation extracted from a parent session branch. */
export interface OwnerBranchContext {
  /** Ordered `[Assistant before owner reply]`, `[Owner]`, and `[Owner answered ask_question]` entries. */
  readonly ownerConversation: string;
  /** Verbatim owner-authored strings (`user` chat replies and completed `ask_question` answers) eligible for grounding. */
  readonly ownerTexts: readonly string[];
  /** Visible assistant messages emitted after the latest owner turn (context only; never owner authority). */
  readonly recentAssistantUpdates: readonly string[];
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n")
    .trim();
}

function selectedOptionsAnswer(selected: unknown): string {
  if (!Array.isArray(selected)) {
    return "";
  }
  return selected
    .filter((opt): opt is string => typeof opt === "string" && opt.trim().length > 0)
    .map((opt) => opt.trim())
    .join(", ");
}

function parseAskQuestionItem(item: unknown): AskQuestionAnswer | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const direct = typeof item.answer === "string" ? item.answer.trim() : "";
  const answer = direct.length > 0 ? direct : selectedOptionsAnswer(item.selectedOptions);
  if (answer.length === 0) {
    return undefined;
  }
  const question = typeof item.question === "string" ? item.question.trim() : "";
  return { question, answer };
}

function parseAskQuestionDetails(details: UnknownRecord): AskQuestionAnswer[] | undefined {
  if (details.cancelled === true || details.timedOut === true || !Array.isArray(details.answers)) {
    return undefined;
  }
  const pairs = details.answers
    .map(parseAskQuestionItem)
    .filter((pair): pair is AskQuestionAnswer => pair !== undefined);
  return pairs.length > 0 ? pairs : undefined;
}

function extractAskQuestionAnswers(message: UnknownRecord): AskQuestionAnswer[] | undefined {
  if (message.toolName !== "ask_question" || message.isError === true) {
    return undefined;
  }
  if (isRecord(message.details)) {
    return parseAskQuestionDetails(message.details);
  }
  const text = extractMessageText(message.content);
  if (text.length === 0 || NON_ANSWER_ASK_QUESTION.test(text)) {
    return undefined;
  }
  const stripped = text.replace(/^User answered:\s*/iu, "").trim();
  return stripped.length > 0 ? [{ question: "", answer: stripped }] : undefined;
}

function formatAskQuestionBlock(answers: readonly AskQuestionAnswer[]): string {
  const lines = ["[Owner answered ask_question]"];
  for (const { question, answer } of answers) {
    if (question.length > 0) {
      lines.push(`Q: ${question}`);
    }
    lines.push(`A: ${answer}`);
  }
  return lines.join("\n");
}

class OwnerTimelineBuilder {
  private readonly turns: string[] = [];
  private readonly ownerTexts: string[] = [];
  private lastAssistant: string | undefined;
  private recentAssistantUpdates: string[] = [];

  visit(entry: unknown): void {
    if (!isRecord(entry)) {
      return;
    }
    if (entry.type === "compaction") {
      if (this.ownerTexts.length > 0) {
        this.turns.push("--- [Context rolled over] ---");
      }
      this.recentAssistantUpdates = [];
      return;
    }
    if (entry.type === "message" && isRecord(entry.message)) {
      this.visitMessage(entry.message);
    }
  }

  build(): OwnerBranchContext | undefined {
    if (this.ownerTexts.length === 0) {
      return undefined;
    }
    return {
      ownerConversation: this.turns.join("\n\n"),
      ownerTexts: this.ownerTexts,
      recentAssistantUpdates: this.recentAssistantUpdates,
    };
  }

  private recordOwnerTurn(formattedTurn: string, groundableTexts: readonly string[]): void {
    if (this.lastAssistant !== undefined) {
      this.turns.push(`[Assistant before owner reply]\n${this.lastAssistant}`);
      this.lastAssistant = undefined;
    }
    this.turns.push(formattedTurn);
    this.ownerTexts.push(...groundableTexts);
    this.recentAssistantUpdates = [];
  }

  private visitMessage(message: UnknownRecord): void {
    const role = message.role;
    if (role === "assistant") {
      const text = extractMessageText(message.content);
      if (text.length > 0) {
        this.lastAssistant = text;
        if (this.ownerTexts.length > 0) {
          this.recentAssistantUpdates.push(text);
        }
      }
      return;
    }
    if (role === "user") {
      const text = extractMessageText(message.content);
      if (text.length > 0) {
        this.recordOwnerTurn(`[Owner]\n${text}`, [text]);
      }
      return;
    }
    if (role === "toolResult") {
      const answers = extractAskQuestionAnswers(message);
      if (answers !== undefined) {
        this.recordOwnerTurn(
          formatAskQuestionBlock(answers),
          answers.map((item) => item.answer),
        );
      }
    }
  }
}

/**
 * Captures the parent branch's chronological owner conversation (pairing short chat replies with
 * the immediately preceding assistant prompt and including completed `ask_question` answers) plus
 * recent assistant updates after the latest owner turn.
 */
export function captureOwnerBranchContext(
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">,
): OwnerBranchContext | undefined {
  const builder = new OwnerTimelineBuilder();
  for (const entry of sessionManager.getBranch()) {
    builder.visit(entry);
  }
  return builder.build();
}

/** Captures chronological owner conversation text from the parent session branch for child skeptics. */
export function captureOwnerContext(
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">,
): string | undefined {
  return captureOwnerBranchContext(sessionManager)?.ownerConversation;
}
