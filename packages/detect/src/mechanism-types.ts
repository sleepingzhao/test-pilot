import type { TestAssertion } from "@testpilot/test-ir";
import type { CapabilityId, RequirementId } from "./types.js";

/** Channels a pack may use. Every new channel needs a provider plus a negative probe. */
export type EvidenceChannel = "ui" | "http" | "ws-frame" | "sse" | "db" | "trace" | "semantic";

export type ScenarioTemplate = {
  id: string;
  title: string;
  /** Deterministic parameters the pack instantiates. The LLM may fill values, not invent steps. */
  parameters: string[];
  evidence: EvidenceChannel[];
  negativeProbeId: string;
};

export type AssertionTemplate = {
  id: string;
  type: TestAssertion["type"];
  provider: string;
  evidence: EvidenceChannel;
  description: string;
};

export type NegativeProbeSpec = {
  id: string;
  description: string;
  break: "block-delivery" | "return-500" | "remove-tool-call" | "feed-hallucination" | "corrupt-file";
};

/**
 * A reviewed, code-level test strategy for one capability. Packs are not generated
 * by an LLM; they are selected by detection and instantiated with evidence.
 */
export type MechanismPack = {
  id: string;
  capability: CapabilityId;
  requires: RequirementId[];
  scenarios: ScenarioTemplate[];
  assertions: AssertionTemplate[];
  negativeProbes: NegativeProbeSpec[];
  safety: {
    mutation: "none" | "sandbox-only" | "allowed";
    maxActions: number;
  };
};
