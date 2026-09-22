// Loopback peer adapted from Pi's ai/test/responses-websocket-server.ts.
// The installed SDK supplies the real Responses client, stream parser, and steering state machine.
import { once } from "node:events";
import { createServer } from "node:http";

export async function createResponsesFixture(WebSocketServer, handle) {
	const requests = [], errors = [], sockets = new Set();
	const server = createServer((_request, response) => {
		errors.push("Unexpected HTTP fallback");
		response.writeHead(500).end();
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const webSockets = new WebSocketServer({ server });
	webSockets.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const body = JSON.parse(raw.toString());
			requests.push(body);
			const request = { body, socket, send: (event) => socket.send(JSON.stringify(event)) };
			Promise.resolve().then(() => handle(request)).catch((error) => {
				errors.push(String(error));
				socket.terminate();
			});
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, errors,
		async close() {
			for (const socket of webSockets.clients) socket.terminate();
			for (const socket of sockets) socket.destroy();
			await Promise.all([
				new Promise((resolve) => webSockets.close(resolve)),
				new Promise((resolve) => server.close(resolve)),
			]);
		},
	};
}

export const zeroUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

export function reply(request, id) {
	const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text: id, annotations: [] }] };
	request.send({ type: "response.created", response: { id, status: "in_progress" } });
	request.send({ type: "response.output_item.added", output_index: 0, item });
	request.send({ type: "response.output_item.done", output_index: 0, item });
	request.send({ type: "response.completed", response: { id, status: "completed", output: [item], end_turn: true, usage: zeroUsage } });
}
