import * as fs from "node:fs";
import * as path from "node:path";
import {
  exitSchema,
  parkedSchema,
  readySchema,
  wakeFailureSchema,
  type Exit,
  type Parked,
  type WakeFailure,
} from "./contracts.ts";
import { read } from "./storage.ts";

/**
 * The durable evidence one actor generation leaves behind. Every reader of these markers asks
 * this module, so no caller re-derives what `ready`, `stopping`, `parking` or `parked` mean.
 */
export interface GenerationEvidence {
  readonly token: string | undefined;
  /** This exact generation published native readiness. */
  readonly ready: boolean;
  /** Parking preparation started; a launcher waits for exit or a removed marker. */
  readonly parking: boolean;
  /** Stop was requested for this exact generation. */
  readonly stopping: boolean;
  readonly exit: Exit | undefined;
  /** Captured working state, possibly published before the old actor exits. */
  readonly parked: Parked | undefined;
  /** The authority file exists, even if it does not parse. */
  readonly parkedFile: boolean;
  /** This child exited without saving its exact working state. */
  readonly parkFailed: boolean;
  readonly wakeFailure: WakeFailure | undefined;
}

export function parkedAuthority(dir: string): Parked | undefined {
  return read(path.join(dir, "parked.json"), parkedSchema);
}

export function parkedToken(dir: string): string | undefined {
  return parkedAuthority(dir)?.token;
}

export function parkedFile(dir: string): boolean {
  return fs.existsSync(path.join(dir, "parked.json"));
}

export function parkingMarker(dir: string): string {
  return path.join(dir, "actor.lock", "parking.json");
}

export function generation(dir: string, token: string | undefined): GenerationEvidence {
  const exit =
    token === undefined ? undefined : read(path.join(dir, `exit-${token}.json`), exitSchema);
  return {
    token,
    ready: token !== undefined && read(path.join(dir, "ready.json"), readySchema)?.token === token,
    parking: fs.existsSync(parkingMarker(dir)),
    stopping: token !== undefined && fs.existsSync(path.join(dir, `stopping-${token}.json`)),
    exit,
    parked: parkedAuthority(dir),
    parkedFile: parkedFile(dir),
    parkFailed: fs.existsSync(path.join(dir, "park-failed.json")),
    wakeFailure:
      token === undefined
        ? undefined
        : read(path.join(dir, `wake-failure-${token}.json`), wakeFailureSchema),
  };
}

/**
 * A failed restore may hand the old parked cut forward only before native open and after that
 * exact generation's death. Any other generation's parked state belongs to someone else.
 */
export function handoffToken(
  evidence: GenerationEvidence,
  actorAlive: boolean,
  expected: string,
): string | undefined {
  const failure = evidence.wakeFailure;
  return !actorAlive && evidence.token === expected && failure?.beforeOpen?.actorToken === expected
    ? failure.beforeOpen.parkedToken
    : undefined;
}

/** Why a spawned actor never became usable, or undefined while it may still publish readiness. */
export function wakeFailureReason(
  evidence: GenerationEvidence,
  options: { readonly legacy: boolean; readonly actorAlive: boolean; readonly directory: string },
): string | undefined {
  if (evidence.exit === undefined && options.actorAlive) {
    return undefined;
  }
  const failure = evidence.wakeFailure;
  return (
    failure?.reason ??
    `Actor exited before ${options.legacy ? "readiness" : "intercom registration"} (code ${evidence.exit?.code ?? "unknown"}, signal ${evidence.exit?.signal ?? "unknown"}). See ${path.join(options.directory, "runner.log")}.`
  );
}
