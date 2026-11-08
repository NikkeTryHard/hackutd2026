import { createBackend } from '../src/backend';
import type { AgentConfig, Backend } from '../src/contracts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const first = await createBackend();
let second: Backend | undefined;
let late: Backend | undefined;
try {
  assert((await first.health()).ok, 'First database client is not healthy');
  second = await createBackend();
  assert((await second.health()).ok, 'Second database client is not healthy');
  const id = `db-smoke-${crypto.randomUUID()}`;
  const config: AgentConfig = {
    id,
    name: 'Database infrastructure smoke',
    scenario: 'shop',
    profile: 'baseline',
    task: 'Infrastructure smoke only',
    verify: false,
  };
  await first.create(config);
  const initial = await first.world(id);
  const deadline = Date.now() + 18000;
  for (;;) {
    const run = await second.get(id);
    if (run) break;
    assert(Date.now() < deadline, 'Second client never observed the new run');
    await Bun.sleep(50);
  }
  await first.message(id, 'two-client message');
  await first.message(id, 'two-client interrupt', { interrupt: true });
  const delivered = await second.takeMessages(id);
  assert(
    delivered[0]?.text === 'two-client message',
    'Second client could not consume the durable message',
  );
  assert(delivered[1]?.text === 'two-client interrupt', 'Interrupt message was not durable');
  assert(delivered[1]?.interrupt === true, 'Interrupt flag was not stored durably');
  let transitioned = false;
  for (;;) {
    const world = await first.world(id);
    if (world.revision > initial.revision && world.notice !== initial.notice) {
      transitioned = true;
      break;
    }
    assert(
      Date.now() < deadline,
      'Scheduled scenario transition did not execute within its documented window',
    );
    await Bun.sleep(100);
  }
  assert(transitioned, 'Transition did not execute');
  late = await createBackend();
  const lateRun = await late.get(id);
  assert(lateRun, 'Late client did not receive run snapshot');
  assert(
    lateRun.events.some((event) => event.kind === 'world'),
    'Late client did not receive durable world history',
  );
  const world = await late.world(id);
  await late.acknowledge(id, world.revision);
  assert(
    (await late.world(id)).appliedRevision === world.revision,
    'Rendered-revision acknowledgment did not persist',
  );
  await first.patch(id, {
    status: 'stopped',
    requested: 'stopped',
    outcome: 'Infrastructure smoke completed; no model executed',
  });
  console.log(
    JSON.stringify(
      {
        label: 'Real SpacetimeDB infrastructure smoke',
        twoClients: true,
        scheduledTransition: true,
        lateJoinHistory: true,
        revisionAcknowledgment: true,
        id,
      },
      null,
      2,
    ),
  );
} finally {
  await late?.close();
  await second?.close();
  await first.close();
}
