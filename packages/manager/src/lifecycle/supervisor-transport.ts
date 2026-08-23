import { createServer, type Server } from "node:net";
import type { SupervisorRequest } from "./socket.js";

type Executor = (request: SupervisorRequest) => Promise<unknown>;
type AfterReply = (request: SupervisorRequest, result: unknown) => void;

export function createSupervisorTransport(
	execute: Executor,
	onSocketError: (error: Error) => void = () => {},
	afterReply: AfterReply = () => {},
): Server {
	return createServer({ allowHalfOpen: true }, (socket) => {
		let input = "";
		let handled = false;
		socket.setEncoding("utf8");
		socket.on("error", (error) => onSocketError(error));
		socket.on("data", (chunk) => {
			input += chunk;
			if (input.length > 65536) socket.destroy(new Error("Request too large."));
		});
		socket.on("end", () => {
			if (handled) return;
			handled = true;
			void (async () => {
				try {
					const request = JSON.parse(input.trim()) as SupervisorRequest;
					if (!request.idempotencyKey)
						throw new Error("idempotencyKey is required.");
					const result = await execute(request);
					if (!socket.destroyed && !socket.writableEnded)
						socket.end(`${JSON.stringify({ ok: true, result })}\n`, () =>
							afterReply(request, result),
						);
				} catch (error) {
					if (!socket.destroyed && !socket.writableEnded)
						socket.end(
							`${JSON.stringify({ ok: false, error: { code: "operation_failed", message: error instanceof Error ? error.message : String(error) } })}\n`,
						);
				}
			})();
		});
	});
}
