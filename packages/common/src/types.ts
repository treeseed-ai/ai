export const JOB_STATES = ['queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled'] as const;
export type JobState = typeof JOB_STATES[number];

export interface Job<T = unknown> {
	id: string;
	type: string;
	request: T;
	state: JobState;
	priority: number;
	progress: number;
	attempts: number;
	maxAttempts: number;
	idempotencyKey: string;
	cancellationRequested: boolean;
	leaseOwner: string | null;
	leaseExpiresAt: string | null;
	error: ApiError | null;
	resultManifest: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface JobEvent {
	id: number;
	jobId: string;
	type: string;
	payload: unknown;
	createdAt: string;
}

export interface ApiError {
	code: string;
	message: string;
	requestId?: string;
	fields?: Array<{ path: string; message: string }>;
}

export interface ArtifactObject {
	uri: string;
	size: number;
	sha256: string;
}

export interface ArtifactManifest {
	schemaVersion: 'ai.artifact/v1';
	artifactId: string;
	artifactType: 'lora-adapter' | 'dataset' | 'document-bundle' | 'checkpoint' | 'archive';
	createdAt: string;
	baseModel?: { id: string; revision: string };
	trainingConfigDigest?: string;
	datasets?: string[];
	adapter?: { format: 'peft'; architecture: string };
	objects: ArtifactObject[];
	evaluations?: Array<{ suite: string; metric: string; value: number }>;
	provenance: Record<string, unknown>;
	signingKeyId: string;
	signature: string;
}

export interface ExperienceArtifact { uri:string; sha256:string; size:number; mimeType:string; sourceUrl?:string; provenance:Record<string,unknown> }
export interface ExperienceTrajectory {
	id:string; sourceClient:'hermes'|'open-webui'; model:string; deploymentRevision:string;
	messages:Array<{role:string;content?:unknown;toolCalls?:unknown;toolCallId?:string}>;
	toolActivity?:unknown[]; artifacts?:ExperienceArtifact[]; validators?:unknown[]; reward?:number;
	critic?:{revision:string;answer:unknown;validated:boolean}; createdAt:string;
}
export interface ExperienceBatchManifest {
	schemaVersion:'ai.experience-batch/v1'; batchId:string; createdAt:string; trajectories:ExperienceTrajectory[];
	redactionPolicyVersion:string; provenance:Record<string,unknown>;
}
