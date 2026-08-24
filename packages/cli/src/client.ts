import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { configPath, keyPath, type ClientConfig } from './contracts.js';

export function config(): ClientConfig {
	try { return JSON.parse(readFileSync(configPath, 'utf8')) as ClientConfig; }
	catch {
		const host = process.env.AI_FACTORY_HOST ?? hostname();
		return { schemaVersion: 'treeai.config/v1', version: '0.9.0', imageSource: 'local-build', ca: process.env.AI_FACTORY_CA_CERT ?? '/etc/ssl/certs/treeseed-ai-factory-development-ca.pem', endpoints: { manager: `https://${host}:4790`, inference: `https://${host}:4770`, openai: `https://${host}:4771`, training: `https://${host}:4780`, lab: `https://${host}:4793` }, installedProducts: [] };
	}
}
export function key() { const environment = process.env.TREEAI_OPERATOR_KEY_VALUE; return environment || readFileSync(keyPath, 'utf8').trim(); }
function redact(value: string) { return value.replace(/authorization\s*:\s*bearer\s+[^\s"']+/giu, '[REDACTED]').replace(/\bbearer\s+[^\s"']+/giu, '[REDACTED]').replace(/\bak_[a-z0-9-]+_[a-z0-9_-]{16,}\b/giu, '[REDACTED]'); }
export function transportError(error: unknown, endpoint: string) {
	const value = error as { status?: number; stderr?: string | Buffer; stdout?: string | Buffer }, detail = [value.stderr, value.stdout].map((item) => redact(String(item ?? '').trim())).filter(Boolean).join('\n');
	return new Error(detail ? `Request to ${endpoint} failed: ${detail}` : `Request to ${endpoint} failed${value.status === undefined ? '.' : ` with status ${value.status}.`}`);
}
export function request(surface: string, path: string, init: { method?: string; body?: string; idempotencyKey?: string } = {}) {
	const settings = config(), endpoint = settings.endpoints[surface];
	if (!endpoint) throw new Error(`No ${surface} endpoint is configured.`);
	const target = `${endpoint}${path}`, args = ['--silent', '--show-error', '--fail-with-body', '--cacert', settings.ca, '-H', `Authorization: Bearer ${key()}`, '-H', 'content-type: application/json', '-X', init.method ?? 'GET'];
	if (init.idempotencyKey) args.push('-H', `Idempotency-Key: ${init.idempotencyKey}`);
	if (init.body) args.push('--data', init.body);
	args.push(target);
	let text: string;
	try { text = execFileSync('curl', args, { encoding: 'utf8' }); }
	catch (error) { throw transportError(error, target); }
	try { return JSON.parse(text) as unknown; } catch { return text; }
}
