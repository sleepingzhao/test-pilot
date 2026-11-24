export {
  recordSession,
  eventsToIR,
  combineActorRecordings,
  splitLoginEvents,
  type RecordedActor,
  assertPlaywrightReady,
  recorderLimitationWarnings,
  assertRecordedIrHasNoPlaintextSecrets,
  type RecordSessionOptions,
  type RecordSessionResult,
} from "./record.js";
export type { RecordedEvent } from "./inject.js";
