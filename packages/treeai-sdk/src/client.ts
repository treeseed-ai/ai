import { TREEAI_OPERATIONS, type TreeAiOperation, type TreeAiOperationId } from './generated/contract.js';

export type TreeAiService = TreeAiOperation['service'];
export interface TreeAiClientOptions {
	endpoints: Record<TreeAiService, string>;
	token?: string | (() => string | Promise<string>);
	fetch?: typeof fetch;
}
export interface TreeAiInvocation { path?: Record<string, string | number>; query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string> }

export class TreeAiApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string, readonly payload?: unknown) { super(message); }
}

export class TreeAiClient {
	readonly #operations = new Map<string, TreeAiOperation>(TREEAI_OPERATIONS.map((operation) => [operation.operationId, operation]));
	readonly #fetch: typeof fetch;
	constructor(readonly options: TreeAiClientOptions) { this.#fetch = options.fetch ?? fetch; }

	async invoke(operationId: TreeAiOperationId, input: TreeAiInvocation = {}) {
		const operation = this.#operations.get(operationId);
		if (!operation) throw new Error(`Unknown TreeAI operation ${operationId}.`);
		let path: string = operation.path;
		for (const [name, value] of Object.entries(input.path ?? {})) path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
		if (/\{[^}]+\}/u.test(path)) throw new Error(`TreeAI operation ${operationId} is missing path parameters.`);
		const url = new URL(path, `${this.options.endpoints[operation.service].replace(/\/$/u, '')}/`);
		for (const [name, value] of Object.entries(input.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
		const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
		const headers = new Headers(input.headers);
		if (token) headers.set('authorization', `Bearer ${token}`);
		if (input.body !== undefined && !(input.body instanceof Uint8Array) && typeof input.body !== 'string') headers.set('content-type', 'application/json');
		const body = input.body === undefined ? undefined : headers.get('content-type') === 'application/json' ? JSON.stringify(input.body) : input.body as BodyInit;
		const response = await this.#fetch(url, { method: operation.method, headers, body });
		const contentType = response.headers.get('content-type') ?? '';
		const payload = contentType.includes('json') ? await response.json() : await response.text();
		if (!response.ok) {
			const problem = payload as { error?: { code?: string; message?: string } };
			throw new TreeAiApiError(response.status, problem?.error?.code ?? 'treeai_error', problem?.error?.message ?? response.statusText, payload);
		}
		return payload;
	}
}
