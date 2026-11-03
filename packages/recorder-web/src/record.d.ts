import type { TestIR } from "@testpilot/test-ir";
import type { RecordedEvent } from "./inject.js";
export type RecordSessionOptions = {
    url: string;
    testId: string;
    /** Called when recording finishes (browser closed or stop invoked). */
    onStop?: () => void;
};
export type RecordSessionResult = {
    ir: TestIR;
    events: RecordedEvent[];
    warnings: string[];
};
export declare function eventsToIR(testId: string, baseUrl: string, events: RecordedEvent[]): TestIR;
export declare function recordSession(options: RecordSessionOptions): Promise<RecordSessionResult>;
//# sourceMappingURL=record.d.ts.map