import type { Pool } from 'pg';
import type { ApiError,Job,JobEvent,JobState } from './types.js';

export interface SubmitJob { type: string; request: unknown; idempotencyKey: string; priority?: number; maxAttempts?: number }
export interface JobRepository {
	submit(input: SubmitJob): Promise<Job>;
	get(id: string): Promise<Job | null>;
	list(limit?: number): Promise<Job[]>;
	events(id: string): Promise<JobEvent[]>;
	cancel(id: string): Promise<Job | null>;
	retry(id: string, idempotencyKey: string): Promise<Job | null>;
	claim(worker: string, types: string[], leaseSeconds: number): Promise<Job | null>;
	heartbeat(id: string, worker: string, leaseSeconds: number, progress?: number): Promise<boolean>;
	complete(id: string, worker: string, resultManifest?: string): Promise<boolean>;
	fail(id: string, worker: string, error: ApiError, retryDelaySeconds: number): Promise<boolean>;
}

function mapJob(row: Record<string,unknown>): Job {
	return {
		id: String(row.id), type: String(row.type), request: row.request, state: String(row.state) as JobState,
		priority: Number(row.priority), progress: Number(row.progress), attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
		idempotencyKey: String(row.idempotency_key), cancellationRequested: Boolean(row.cancellation_requested),
		leaseOwner: row.lease_owner ? String(row.lease_owner) : null, leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string).toISOString() : null,
		error: row.error as ApiError | null, resultManifest: row.result_manifest ? String(row.result_manifest) : null,
		createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
	};
}

export class PostgresJobRepository implements JobRepository {
	constructor(readonly pool: Pool) {}
	private async event(jobId:string,type:string,payload:unknown={}) { await this.pool.query('INSERT INTO job_events(job_id,type,payload) VALUES($1,$2,$3)',[jobId,type,payload]); }
	async submit(input: SubmitJob) {
		const result = await this.pool.query(`INSERT INTO jobs(type,request,idempotency_key,priority,max_attempts) VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`, [input.type, input.request, input.idempotencyKey, input.priority ?? 0, input.maxAttempts ?? 3]);
		const job=mapJob(result.rows[0]);if(job.attempts===0&&(await this.events(job.id)).length===0)await this.event(job.id,'submitted',{});return job;
	}
	async get(id: string) { const result = await this.pool.query('SELECT * FROM jobs WHERE id=$1', [id]); return result.rowCount ? mapJob(result.rows[0]) : null; }
	async list(limit = 100) { const result = await this.pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1', [Math.min(limit, 500)]); return result.rows.map(mapJob); }
	async events(id: string) { const result = await this.pool.query('SELECT id,job_id,type,payload,created_at FROM job_events WHERE job_id=$1 ORDER BY id', [id]); return result.rows.map((row) => ({ id: Number(row.id), jobId: row.job_id, type: row.type, payload: row.payload, createdAt: new Date(row.created_at).toISOString() })); }
	async cancel(id: string) {
		const result = await this.pool.query(`UPDATE jobs SET cancellation_requested=true,state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,updated_at=now() WHERE id=$1 AND state IN ('queued','claimed','running') RETURNING *`, [id]);
		if(result.rowCount)await this.event(id,String(result.rows[0].state),{});return result.rowCount ? mapJob(result.rows[0]) : this.get(id);
	}
	async retry(id:string,idempotencyKey:string){const result=await this.pool.query(`INSERT INTO jobs(type,request,idempotency_key,priority,max_attempts) SELECT type,request,$2,priority,max_attempts FROM jobs WHERE id=$1 AND state IN ('failed','cancelled') ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING *`,[id,`retry:${id}:${idempotencyKey}`]);if(!result.rowCount)return null;const job=mapJob(result.rows[0]),created=(await this.events(job.id)).length===0;if(created){await this.event(job.id,'submitted',{retryOf:id});await this.event(id,'retried',{jobId:job.id});}return job;}
	async claim(worker: string, types: string[], leaseSeconds: number) {
		const result = await this.pool.query(`WITH candidate AS (SELECT id FROM jobs WHERE type=ANY($2) AND cancellation_requested=false AND ((state='queued' AND available_at<=now()) OR (state IN ('claimed','running') AND lease_expires_at<now())) ORDER BY priority DESC,created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET state='claimed',lease_owner=$1,lease_expires_at=now()+make_interval(secs=>$3),attempts=attempts+1,updated_at=now() FROM candidate WHERE jobs.id=candidate.id RETURNING jobs.*`, [worker, types, leaseSeconds]);
		if(result.rowCount)await this.event(String(result.rows[0].id),'claimed',{worker});return result.rowCount ? mapJob(result.rows[0]) : null;
	}
	async heartbeat(id: string, worker: string, leaseSeconds: number, progress?: number) {
		const result = await this.pool.query(`UPDATE jobs SET state='running',lease_expires_at=now()+make_interval(secs=>$3),progress=COALESCE($4,progress),updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state IN ('claimed','running','cancelling')`, [id, worker, leaseSeconds, progress]);
		if(result.rowCount&&progress!==undefined)await this.event(id,'progress',{progress});return Boolean(result.rowCount);
	}
	async complete(id: string, worker: string, resultManifest?: string) {
		const result = await this.pool.query(`UPDATE jobs SET state=CASE WHEN cancellation_requested THEN 'cancelled' ELSE 'succeeded' END,progress=CASE WHEN cancellation_requested THEN progress ELSE 1 END,error=CASE WHEN cancellation_requested THEN error ELSE null END,result_manifest=$3,lease_owner=null,lease_expires_at=null,updated_at=now() WHERE id=$1 AND lease_owner=$2`, [id, worker, resultManifest ?? null]);
		if(result.rowCount)await this.event(id,'completed',{resultManifest:resultManifest??null});return Boolean(result.rowCount);
	}
	async fail(id: string, worker: string, error: ApiError, retryDelaySeconds: number) {
		const result = await this.pool.query(`UPDATE jobs SET state=CASE WHEN cancellation_requested THEN 'cancelled' WHEN attempts<max_attempts THEN 'queued' ELSE 'failed' END,error=$3,available_at=now()+make_interval(secs=>$4),lease_owner=null,lease_expires_at=null,updated_at=now() WHERE id=$1 AND lease_owner=$2`, [id, worker, error, retryDelaySeconds]);
		if(result.rowCount)await this.event(id,'failed',{error});return Boolean(result.rowCount);
	}
}

export class MemoryJobRepository implements JobRepository {
	readonly records = new Map<string,Job>(); readonly history = new Map<string,JobEvent[]>();
	async submit(input: SubmitJob) {
		const existing = [...this.records.values()].find((job) => job.idempotencyKey === input.idempotencyKey); if (existing) return existing;
		const now = new Date().toISOString(); const job: Job = { id: crypto.randomUUID(),type: input.type,request: input.request,state: 'queued',priority: input.priority ?? 0,progress: 0,attempts: 0,maxAttempts: input.maxAttempts ?? 3,idempotencyKey: input.idempotencyKey,cancellationRequested: false,leaseOwner: null,leaseExpiresAt: null,error: null,resultManifest: null,createdAt: now,updatedAt: now };
		this.records.set(job.id, job); this.addEvent(job.id, 'submitted', {}); return job;
	}
	async get(id: string) { return this.records.get(id) ?? null; }
	async list(limit = 100) { return [...this.records.values()].slice(-limit).reverse(); }
	async events(id: string) { return this.history.get(id) ?? []; }
	async cancel(id: string) { const job = this.records.get(id); if (!job) return null; job.cancellationRequested = true; job.state = job.state === 'queued' ? 'cancelled' : 'cancelling'; this.touch(job); return job; }
	async retry(id:string,idempotencyKey:string){const original=this.records.get(id),key=`retry:${id}:${idempotencyKey}`;if(!original||!['failed','cancelled'].includes(original.state))return null;const existing=[...this.records.values()].find(job=>job.idempotencyKey===key);if(existing)return existing;const job=await this.submit({type:original.type,request:original.request,idempotencyKey:key,priority:original.priority,maxAttempts:original.maxAttempts});this.addEvent(id,'retried',{jobId:job.id});return job;}
	async claim(worker: string, types: string[], leaseSeconds: number) { const job = [...this.records.values()].filter((entry) => entry.state === 'queued' && types.includes(entry.type) && !entry.cancellationRequested).sort((a,b) => b.priority-a.priority)[0]; if (!job) return null; job.state='claimed'; job.leaseOwner=worker; job.leaseExpiresAt=new Date(Date.now()+leaseSeconds*1000).toISOString(); job.attempts++; this.touch(job); return job; }
	async heartbeat(id: string, worker: string, leaseSeconds: number, progress?: number) { const job=this.records.get(id); if (!job || job.leaseOwner!==worker) return false; job.state=job.cancellationRequested?'cancelling':'running'; job.leaseExpiresAt=new Date(Date.now()+leaseSeconds*1000).toISOString(); if(progress!==undefined) job.progress=progress; this.touch(job); return true; }
	async complete(id: string, worker: string, resultManifest?: string) { const job=this.records.get(id); if(!job||job.leaseOwner!==worker)return false; job.state=job.cancellationRequested?'cancelled':'succeeded'; job.progress=job.cancellationRequested?job.progress:1;if(!job.cancellationRequested)job.error=null;job.resultManifest=resultManifest??null; job.leaseOwner=null; this.touch(job); return true; }
	async fail(id: string, worker: string, error: ApiError) { const job=this.records.get(id); if(!job||job.leaseOwner!==worker)return false; job.error=error; job.state=job.cancellationRequested?'cancelled':job.attempts<job.maxAttempts?'queued':'failed'; job.leaseOwner=null; this.touch(job); return true; }
	private touch(job: Job) { job.updatedAt=new Date().toISOString(); this.addEvent(job.id, job.state, { progress: job.progress }); }
	private addEvent(id: string,type: string,payload: unknown) { const values=this.history.get(id)??[]; values.push({ id: values.length+1,jobId:id,type,payload,createdAt:new Date().toISOString() }); this.history.set(id,values); }
}
