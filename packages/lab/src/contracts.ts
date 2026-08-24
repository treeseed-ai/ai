export interface InferenceCaptureV2 {
	schemaVersion: "ai.inference-capture/v2"; id: string; turnId: string;
	sourceClient: "hermes" | "open-webui"; capturedAt: string; requestDigest: string;
	request: Record<string, unknown>; response: unknown; status: number; requestedModel: string;
	hermesSessionId?: string; hermesTurnId?: string;
	resolvedDeployment: { baseModelRevision: string; deploymentRevision: string; adapterId?: string };
}
export interface AgentTrajectoryEvent {
	id: string; role: "system" | "user" | "assistant" | "tool"; content?: unknown;
	toolName?: string; toolCallId?: string; toolArguments?: unknown; timestamp?: string; tokenCount?: number;
}
export interface AgentActionSequenceV1 {
	schemaVersion: "ai.agent-action-sequence/v1"; id: string; trajectoryId: string;
	startEvent: number; endEvent: number; events: AgentTrajectoryEvent[];
	eligibility: { correctiveSft: boolean; kto: boolean };
}
export interface AgentTrajectoryV1 {
	schemaVersion: "ai.agent-trajectory/v1"; id: string; hermesSessionId: string;
	sourceClient: "open-webui" | "hermes-dashboard" | "hermes-api"; createdAt: string; finalizedAt: string;
	model: string; deploymentRevision: string; events: AgentTrajectoryEvent[];
	actionSequenceIds: string[]; artifactObservationIds: string[];
	eligibility: { continualPretraining: { eligible: boolean; libraryIds: string[]; documentTags: string[] }; correctiveSft: { eligible: boolean }; kto: { eligible: boolean } };
}
export interface ArtifactObservationV1 {
	schemaVersion: "ai.artifact-observation/v1"; id: string; trajectoryId: string;
	relativePath: string; sha256: string; size: number; mimeType: string; observedAt: string;
	provenance: Record<string, unknown>;
}
export interface KtoLabelRevision {
	schemaVersion: "ai.kto-label/v1"; id: string; actionSequenceId: string; score: number;
	label: "desirable" | "undesirable"; confidence: number; rationale: string;
	evaluator: { model: string; revision: string; harness: string }; createdAt: string;
	supersedes?: string; validatorOverride?: { validator: string; reason: string };
}
export interface ContinualPretrainingEligibility {
	schemaVersion: "ai.continual-pretraining-eligibility/v1"; id: string; documentRevision: string;
	libraryIds: string[]; documentTags: string[]; extractionProvenance: Record<string, unknown>;
	rawTextCorpusEligible: boolean; createdAt: string;
}
export interface CorrectiveSftRevision {
	schemaVersion: "ai.corrective-sft-revision/v1"; id: string; actionSequenceId: string;
	critiqueRevision: string; correctedCompletion: unknown; validatorOutcome: { passed: boolean; validator?: string; explanation?: string };
	evaluator: { model: string; revision: string; harness: string }; createdAt: string; supersedes?: string;
}
export interface AdapterLineageV1 {
	schemaVersion: "ai.adapter-lineage/v1"; id: string; purpose: "continual-pretraining" | "corrective-sft" | "kto" | "composed";
	baseModelRevision: string; targetModules: string[]; rank: number; alpha: number;
	parentAdapterIds: string[]; datasetManifestIds: string[]; createdAt: string;
}
export interface AgentProfileV1 {
	schemaVersion: "ai.agent-profile/v1"; id: string; slug: string; displayName: string; description: string; icon?: string;
	status: "draft" | "enabled" | "disabled"; modelAlias: string; adapterArtifactId?: string; baseModelRevision: string;
	systemInstructions: string; allowedTools: string[]; memoryPolicy: "session" | "none"; contextPolicy: string;
	lineage: string[]; evaluations: string[]; createdAt: string; updatedAt: string;
}
export interface AgentRoutingDecisionV1 {
	schemaVersion: "ai.agent-routing-decision/v1"; id: string; conversationId?: string; segmentId: string; requestedModel: string;
	candidates: string[]; selectedProfileId: string; selectedModelAlias: string; confidence: number; rationale: string;
	priorSegmentId?: string; structuredStateDigest?: string; createdAt: string;
}
