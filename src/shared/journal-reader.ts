// Stable public journal entry point; each module owns one storage responsibility.
export { JsonProjection, type Projection, type ProjectionLimits } from "./json-projection.ts";
export {
  JournalFrames,
  scanJournal,
  readJsonProjection,
  type JournalRecord,
  type JournalPolicy,
  type JournalOptions,
} from "./journal-frames.ts";
export { ownerProjection, nativeProjection } from "./journal-projections.ts";
export {
  NativeJournal,
  journalStamp,
  type NativeRecord,
  type NativePreview,
} from "./native-journal.ts";
export { readOutputPage } from "./output-page.ts";
