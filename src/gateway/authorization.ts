import type { MiddlewareHandler } from 'hono';

export function bearerAuthorization(expectedToken: string): MiddlewareHandler {
	return async (context, next) => {
		if (!expectedToken) return context.json({ error: { code: 'gateway_not_configured', message: 'The inference gateway token is not configured.', type: 'authentication_error' } }, 503);
		const authorization = context.req.header('authorization') ?? '';
		if (authorization !== `Bearer ${expectedToken}`) return context.json({ error: { code: 'invalid_api_key', message: 'The inference gateway API key is invalid.', type: 'authentication_error' } }, 401);
		await next();
	};
}
