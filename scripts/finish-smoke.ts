import { createBackend } from '../src/backend';

const backend = await createBackend();
try {
  let stopped = 0;
  for (const run of await backend.list()) {
    if (
      /^(?:smoke-|db-smoke-)/.test(run.config.id) &&
      !['completed', 'failed', 'stopped'].includes(run.status)
    ) {
      await backend.patch(run.config.id, {
        status: 'stopped',
        requested: 'stopped',
        outcome: 'Deterministic infrastructure fixture finished; no model executed',
      });
      stopped += 1;
    }
  }
  console.log({ infrastructureFixturesStopped: stopped });
} finally {
  await backend.close();
}
