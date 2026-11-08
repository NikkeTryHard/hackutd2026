import { spawn } from 'bun';

// A named Docker volume preserves the development database across application restarts.
// Loopback publication is intentional: this database is not a public service.
const action = Bun.argv[2] || 'start';
if (action !== 'start' && action !== 'logs')
  throw new Error('Usage: bun scripts/database.ts [start|logs]');
const name = Bun.env.SIGHTLINE_DB_CONTAINER || 'sightline-db-runtime';
if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid database container name');
async function run(args: string[]) {
  const child = spawn(['docker', ...args], { stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Docker command failed with exit code ${code}`);
}
if (action === 'logs') await run(['logs', '--tail', '50', name]);
else {
  const inspect = spawn(
    ['docker', 'container', 'inspect', name, '--format', '{{.State.Running}}'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const code = await inspect.exited;
  if (code === 0) {
    const running = (await new Response(inspect.stdout).text()).trim();
    if (running !== 'true') await run(['start', name]);
  } else
    await run([
      'run',
      '-d',
      '--name',
      name,
      '--user',
      '0:0',
      '-p',
      '127.0.0.1:3000:3000',
      '-v',
      'sightline-db-data:/data',
      'clockworklabs/spacetime:v2.14.1',
      'start',
      '--data-dir',
      '/data',
      '--non-interactive',
    ]);
  console.log(
    'Sightline database container is running on http://127.0.0.1:3000. Publish the module before starting agent runs.',
  );
}
