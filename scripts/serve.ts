import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dev = process.argv.slice(2).includes('--dev');
const port = Number(process.env.PORT || 4310);
const replicaPort = Number(process.env.REPLICA_PORT || 4311);
const nextPort = Number(process.env.NEXT_PORT || 4312);
const isPort = (value: number) => Number.isInteger(value) && value >= 1024 && value <= 65535;
if (
  !isPort(port) ||
  !isPort(replicaPort) ||
  !isPort(nextPort) ||
  new Set([port, replicaPort, nextPort]).size !== 3
)
  throw new Error('PORT, REPLICA_PORT and NEXT_PORT must be distinct integer ports in 1024–65535');

const nextOrigin = `http://127.0.0.1:${nextPort}`;
const nextBin = resolve(root, 'node_modules/next/dist/bin/next');
type Child = Bun.Subprocess<'inherit', 'inherit', 'inherit'>;
const children = new Set<Child>();
let signalled = false;
let shutdown: Promise<void> | undefined;

function start(label: string, command: string[]): Child {
  console.log(`Starting ${label}`);
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.add(child);
  return child;
}

async function waitForNext(next: Child) {
  const deadline = Date.now() + 60_000;
  let failure = 'no response';
  while (Date.now() < deadline) {
    if (next.exitCode !== null)
      throw new Error(`Next exited before it was ready (code ${next.exitCode})`);
    let response: Response;
    try {
      response = await fetch(`${nextOrigin}/`, {
        redirect: 'manual',
        headers: { 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await Bun.sleep(200);
      continue;
    }
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`Next returned ${response.status} at ${nextOrigin} instead of the dashboard`);
    return;
  }
  throw new Error(`Next did not become ready at ${nextOrigin}: ${failure}`);
}

function terminate(): Promise<void> {
  shutdown ??= (async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      Promise.allSettled([...children].map((child) => child.exited)),
      Bun.sleep(10_000),
    ]);
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.allSettled([...children].map((child) => child.exited));
  })();
  return shutdown;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    signalled = true;
    console.log(`Stopping Sightline (${signal})`);
    void terminate()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('Sightline shutdown failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      });
  });

async function main() {
  const next = start('Next', [
    process.execPath,
    '--bun',
    nextBin,
    dev ? 'dev' : 'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(nextPort),
  ]);
  await waitForNext(next);
  console.log(`Next ready at ${nextOrigin}`);
  const backend = start('Sightline backend', [process.execPath, resolve(root, 'src/server.ts')]);
  const labelled: Array<[Child, string]> = [
    [next, 'Next'],
    [backend, 'Sightline backend'],
  ];
  const exit = await Promise.race(
    labelled.map(([child, label]) => child.exited.then((code) => ({ child, label, code }))),
  );
  if (signalled) return;
  console.error(`${exit.label} exited unexpectedly (code ${exit.code}); shutting down`);
  await terminate();
  process.exit(exit.code === 0 ? 1 : exit.code);
}

main().catch(async (error) => {
  console.error('Sightline failed to start:', error instanceof Error ? error.message : error);
  await terminate();
  process.exit(signalled ? 0 : 1);
});
