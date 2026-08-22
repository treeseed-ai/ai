export interface RouteSpec { method: string; path: string; summary: string; scope?: string; requestSchema?: object; responseSchema?: object }

export function openApiDocument(input: { title: string; version: string; routes: RouteSpec[] }) {
	const paths: Record<string,Record<string,unknown>> = {};
	for (const route of input.routes) {
		const path = route.path.replace(/:([^/]+)/gu, '{$1}');
		paths[path] ??= {};
		paths[path]![route.method.toLowerCase()] = {
			summary: route.summary,
			security: route.scope ? [{ apiKey: [route.scope] }] : [],
			...(route.requestSchema ? { requestBody: { required: true, content: { 'application/json': { schema: route.requestSchema } } } } : {}),
			responses: { '200': { description: 'Success' }, '202': { description: 'Accepted' }, '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '403': { description: 'Forbidden' } },
		};
	}
	return { openapi: '3.1.1', info: { title: input.title, version: input.version }, paths, components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ak_<id>_<secret>' } } } };
}

export const jsonObjectSchema = { type: 'object', additionalProperties: true };
