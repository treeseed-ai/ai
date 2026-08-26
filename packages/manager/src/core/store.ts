import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./paths.js";
export type WorkKind =
	| "transition"
	| "update-check"
	| "update-plan"
	| "reconcile"
	| "qualification";
export interface WorkRecord {
	id: string;
	kind: WorkKind;
	state:
		| "queued"
		| "running"
		| "succeeded"
		| "failed"
		| "postponed"
		| "cancelled";
	idempotencyKey: string;
	request: unknown;
	result?: unknown;
	error?: string;
	createdAt: string;
	updatedAt: string;
}
let current: DatabaseSync | undefined;
function db() {
	if (current) return current;
	mkdirSync(dirname(paths.database), { recursive: true, mode: 0o2770 });
	const existed = existsSync(paths.database);
	current = new DatabaseSync(paths.database);
	if (!existed) chmodSync(paths.database, 0o660);
	current.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,request TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generations(generation INTEGER PRIMARY KEY,channel TEXT NOT NULL,state TEXT NOT NULL,catalog TEXT NOT NULL,receipt TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
	return current;
}
function parse(row: Record<string, unknown>): WorkRecord {
	return {
		id: String(row.id),
		kind: String(row.kind) as WorkKind,
		state: String(row.state) as WorkRecord["state"],
		idempotencyKey: String(row.idempotency_key),
		request: JSON.parse(String(row.request)),
		...(row.result ? { result: JSON.parse(String(row.result)) } : {}),
		...(row.error ? { error: String(row.error) } : {}),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}
export function createWork(
	kind: WorkKind,
	idempotencyKey: string,
	request: unknown,
) {
	const existing = db()
		.prepare("SELECT * FROM work WHERE idempotency_key=?")
		.get(idempotencyKey) as Record<string, unknown> | undefined;
	if (existing) return parse(existing);
	const now = new Date().toISOString(),
		id = crypto.randomUUID();
	db()
		.prepare("INSERT INTO work VALUES(?,?,?,?,?,?,?,?,?)")
		.run(
			id,
			kind,
			"queued",
			idempotencyKey,
			JSON.stringify(request),
			null,
			null,
			now,
			now,
		);
	event("work.queued", { id, kind });
	return getWork(id)!;
}
export function getWork(id: string) {
	const row = db().prepare("SELECT * FROM work WHERE id=?").get(id) as
		| Record<string, unknown>
		| undefined;
	return row ? parse(row) : undefined;
}
export function unfinishedWork(kind: WorkKind) {
	return (db().prepare("SELECT * FROM work WHERE kind=? AND state IN ('queued','running') ORDER BY created_at").all(kind) as Array<Record<string, unknown>>).map(parse);
}
export function finishWork(
	id: string,
	state: WorkRecord["state"],
	result?: unknown,
	error?: string,
) {
	const now = new Date().toISOString();
	db()
		.prepare("UPDATE work SET state=?,result=?,error=?,updated_at=? WHERE id=?")
		.run(
			state,
			result === undefined ? null : JSON.stringify(result),
			error ?? null,
			now,
			id,
		);
	event(`work.${state}`, { id, error });
	return getWork(id);
}
export function event(type: string, data: unknown) {
	const createdAt = new Date().toISOString();
	const result = db()
		.prepare("INSERT INTO events(type,data,created_at) VALUES(?,?,?)")
		.run(type, JSON.stringify(data), createdAt);
	return { id: String(result.lastInsertRowid), type, data, createdAt };
}
export function events(after = 0, limit = 200) {
	return (
		db()
			.prepare("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?")
			.all(after, limit) as Array<Record<string, unknown>>
	).map((row) => ({
		id: String(row.id),
		type: String(row.type),
		data: JSON.parse(String(row.data)),
		createdAt: String(row.created_at),
	}));
}
export function setting<T>(key: string, fallback: T): T {
	const row = db()
		.prepare("SELECT value FROM settings WHERE key=?")
		.get(key) as { value: string } | undefined;
	return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
	db()
		.prepare(
			"INSERT INTO settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
		)
		.run(key, JSON.stringify(value), new Date().toISOString());
}
export function closeStore() {
	current?.close();
	current = undefined;
}
