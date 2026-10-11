// Immutable wire records, capability routes, registry projection and mutable job
// projection have separate owners. This file preserves the public API.
export {
  NESTED_EVENTS_DIR,
  isSafeNestedId,
  assertSafeNestedId,
  type NestedRoute,
  type NestedEventRecord,
  type NestedControlResultRecord,
  type NestedControlRequestRecord,
  type NestedRegistry,
} from "./nested-protocol.ts";
export {
  createNestedRoute,
  resolveNestedRouteFromEnv,
  resolveInheritedNestedRouteFromEnv,
  resolveNestedParentAddressFromEnv,
  resolveNestedAsyncDir,
} from "./nested-route.ts";
export { sanitizeSummary } from "./nested-validation.ts";
export {
  applyNestedEvent,
  findNestedRouteForRootId,
  projectNestedRegistryForRoot,
  findNestedRun,
  findNestedRunMatchesById,
  readNestedRegistry,
  projectNestedEvents,
  type NestedRunMatch,
  type NestedRunResolutionScope,
} from "./nested-registry.ts";
export {
  writeNestedEvent,
  writeNestedControlRequest,
  readNestedControlRequests,
  writeNestedControlResult,
  readNestedControlResults,
} from "./nested-control-records.ts";
export {
  attachRootChildrenToSteps,
  updateAsyncJobNestedProjection,
  hasLiveNestedDescendants,
  nestedSummaryFromAsyncStatus,
  nestedResultsPath,
} from "./nested-projection.ts";
