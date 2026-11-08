import { resolve } from 'node:path';

// The stdio gateway owns provider auth and reasoning translation. Sightline never
// reads or copies OMP credentials, and this adapter is bound only to loopback.
const model = 'opencode-go/deepseek-v4.1-flash:low';
const child = Bun.spawn(['omp', 'auth-gateway', 'stdio'], {
  cwd: resolve(import.meta.dir, '..'),
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
});
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (response: Response) => void; reject: (error: Error) => void }
>();
const {
  promise: ready,
  resolve: readyResolve,
  reject: readyReject,
} = Promise.withResolvers<void>();
const reader = (async () => {
  let buffer = '';
  const stream = child.stdout.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        ready?: boolean;
        id?: number;
        status?: number;
        body?: unknown;
      };
      if (message.ready) {
        readyResolve();
        continue;
      }
      if (message.id === undefined) continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      request.resolve(Response.json(message.body, { status: message.status ?? 502 }));
    }
  }
  throw new Error('OMP model gateway closed');
})();
void reader.catch((error: unknown) => {
  const failure = error instanceof Error ? error : new Error(String(error));
  readyReject(failure);
  for (const request of pending.values()) request.reject(failure);
  pending.clear();
});
await ready;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 4313,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.host !== '127.0.0.1:4313') return new Response('Invalid host', { status: 403 });
    if (request.method === 'GET' && url.pathname === '/v1/models')
      return Response.json({ data: [{ id: model }] });
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions')
      return new Response('Not found', { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    if (body.model !== model || body.stream === true)
      return new Response('Only the configured non-streaming demo model is allowed', {
        status: 400,
      });
    // DeepSeek's cap includes hidden reasoning. The screenshot adapter's small
    // JSON-output cap can exhaust that budget before it emits any action.
    body.max_tokens = 16384;
    const id = ++sequence;
    const { promise: response, resolve, reject } = Promise.withResolvers<Response>();
    pending.set(id, { resolve, reject });
    await child.stdin.write(`${JSON.stringify({ id, path: '/v1/chat/completions', body })}\n`);
    return response;
  },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void server.stop(true);
    child.kill(signal);
    process.exit(0);
  });
console.log(`Sightline OMP model ready at http://127.0.0.1:4313/v1 · ${model}`);
await child.exited;
process.exit(1);
