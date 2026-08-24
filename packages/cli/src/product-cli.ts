#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { config, key, request } from './client.js';
import { envelope } from './contracts.js';

const [group, command, ...args] = process.argv.slice(2), json = args.includes('--json');
function id() { const value = args.find((item) => !item.startsWith('-')); if (!value) throw new Error(`${command} requires an identifier.`); return value; }
async function stream(surface: string) {
	const settings = config(), child = spawn('curl', ['--no-buffer', '--silent', '--show-error', '--cacert', settings.ca, '-H', `Authorization: Bearer ${key()}`, `${settings.endpoints[surface]}/v1/events/stream`], { stdio: 'inherit' });
	await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code ? reject(new Error(`Event stream exited with ${code}.`)) : resolve()); });
}
function trainingLibrary(action: string | undefined, libraryId: string | undefined) {
	if (!libraryId) throw new Error('A library ID is required.');
	const root = `/v1/libraries/${encodeURIComponent(libraryId)}`;
	if (action === 'documents') return request('training', `${root}/documents`);
	if (action === 'snapshots') return request('training', `${root}/snapshots`);
	if (action === 'retry') {
		const documentId = args[2];
		if (!documentId) throw new Error('A document ID is required.');
		return request('training', `${root}/documents/${encodeURIComponent(documentId)}/retry`, { method: 'POST', idempotencyKey: crypto.randomUUID() });
	}
	throw new Error('Usage: treeai training library documents|snapshots <id> | retry <library-id> <document-id>');
}
async function main() {
	let result: unknown;
	if (group === 'inference') {
		if (command === 'status' || command === 'verify') result = request('inference', command === 'verify' ? '/readyz' : '/v1/version');
		else if (command === 'models') result = request('inference', '/v1/models');
		else if (command === 'jobs') result = request('inference', '/v1/jobs');
		else if (command === 'cancel') result = request('inference', `/v1/jobs/${id()}/cancel`, { method: 'POST' });
		else if (command === 'promote') result = request('inference', '/v1/promotions', { method: 'POST', body: JSON.stringify({ candidateId: id(), idempotencyKey: crypto.randomUUID() }) });
		else if (command === 'rollback') result = request('inference', '/v1/deployments/rollback', { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
		else if (command === 'library') {
			const action = args[0], libraryId = args[1];
			if (action === 'deployments') result = request('inference', '/v1/library-deployments');
			else if (action === 'rollback' && libraryId) result = request('inference', `/v1/library-deployments/${encodeURIComponent(libraryId)}/rollback`, { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
			else throw new Error('Usage: treeai inference library deployments|rollback <id>');
		} else if (command === 'watch') return stream('inference');
		else throw new Error('Unknown inference command.');
	} else if (group === 'training') {
		if (command === 'status' || command === 'verify') result = request('training', command === 'verify' ? '/readyz' : '/v1/version');
		else if (command === 'documents') result = request('training', '/v1/documents');
		else if (command === 'datasets') result = request('training', '/v1/datasets');
		else if (command === 'runs') result = request('training', '/v1/training-runs');
		else if (command === 'jobs') result = request('training', '/v1/jobs');
		else if (command === 'cancel') result = request('training', `/v1/jobs/${id()}/cancel`, { method: 'POST' });
		else if (command === 'library') result = trainingLibrary(args[0], args[1]);
		else if (command === 'watch') return stream('training');
		else throw new Error('Unknown training command.');
	} else throw new Error('Unsupported product group.');
	process.stdout.write(`${JSON.stringify(result, null, json ? 2 : 0)}\n`);
}
main().catch((error) => {
	const value = envelope('treeai_product_error', error instanceof Error ? error.message : String(error));
	process.stderr.write(`${json ? JSON.stringify(value) : value.error.message}\n`);
	process.exitCode = 1;
});
