// @vitest-environment node
// These exercise server-side modules; jsdom would make the SDK refuse to load.
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { freshBoard, reopenBoard, type Harness } from '@/lib/agentic/__tests__/harness';

let harness: Harness;

afterEach(async () => {
  await harness?.cleanup();
});

const WORKER_A = { id: 'worker-a', name: 'Worker A', role: 'worker' as const };
const WORKER_B = { id: 'worker-b', name: 'Worker B', role: 'worker' as const };

/** Seeds one objective with a single ready task and returns its id. */
async function seedReadyTask(h: Harness, title = 'Do the thing') {
  return h.store.withBoard((board) => {
    board.objectives.push({
      id: 'obj_1',
      goal: 'Test objective',
      status: 'active',
      planRationale: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const task = h.store.createTask(
      board,
      { id: 'agent-planner', name: 'Planner', role: 'planner' },
      { objectiveId: 'obj_1', title, details: 'details' },
      'seeded for a test'
    );
    task.status = 'ready';
    [WORKER_A, WORKER_B].forEach((actor) =>
      h.store.upsertAgent(board, {
        id: actor.id,
        name: actor.name,
        role: 'worker',
        status: 'idle',
        currentTaskId: null,
        activity: null,
        tasksCompleted: 0,
        lastSeenAt: new Date().toISOString(),
      })
    );
    return task.id;
  });
}

describe('claiming is mutually exclusive', () => {
  it('lets exactly one of two agents win a contested task', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);

    const before = await harness.store.readBoard();
    const version = before.tasks[0].version;

    // Both agents decided against the same observed version, as they would
    // when polling the board at the same moment.
    const results = await Promise.allSettled([
      harness.store.withBoard((board) =>
        harness.store.claimTask(board, taskId, WORKER_A, version, 'A saw it first')
      ),
      harness.store.withBoard((board) =>
        harness.store.claimTask(board, taskId, WORKER_B, version, 'B saw it first')
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const after = await harness.store.readBoard();
    expect(after.tasks[0].status).toBe('claimed');
    expect(after.tasks[0].lease).not.toBeNull();
  });

  it('rejects a claim decided against a stale version', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const stale = (await harness.store.readBoard()).tasks[0].version;

    // A human reprioritises, which bumps the version.
    await harness.human.reprioritiseTask(taskId, 1, 'Needed sooner.');

    await expect(
      harness.store.withBoard((board) =>
        harness.store.claimTask(board, taskId, WORKER_A, stale, 'acting on old state')
      )
    ).rejects.toThrow(/changed while/);
  });

  it('stops a non-holder from moving a held task', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const version = (await harness.store.readBoard()).tasks[0].version;

    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'claimed')
    );

    await expect(
      harness.store.withBoard((board) =>
        harness.store.transitionTask(board, taskId, WORKER_B, 'in_progress', 'not mine to move')
      )
    ).rejects.toThrow(/holds the lease/);
  });

  it('stops an agent from finishing a task it never claimed', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);

    await expect(
      harness.store.withBoard((board) =>
        harness.store.transitionTask(board, taskId, WORKER_A, 'in_progress', 'skipping the claim')
      )
    ).rejects.toThrow(/must claim/);
  });
});

describe('leases', () => {
  it('returns an abandoned task to the queue once its lease expires', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const version = (await harness.store.readBoard()).tasks[0].version;

    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'claimed')
    );

    const future = new Date(Date.now() + harness.store.LEASE_DURATION_MS + 1_000);
    const reaped = await harness.store.withBoard((board) =>
      harness.store.reapExpiredLeases(board, future)
    );

    expect(reaped).toHaveLength(1);
    const after = await harness.store.readBoard();
    expect(after.tasks[0].status).toBe('ready');
    expect(after.tasks[0].lease).toBeNull();
    expect(after.audit.some((event) => event.action === 'task.lease_expired')).toBe(true);
  });

  it('keeps a task held while the agent renews its lease', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const version = (await harness.store.readBoard()).tasks[0].version;

    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'claimed')
    );

    const midway = new Date(Date.now() + harness.store.LEASE_DURATION_MS / 2);
    await harness.store.withBoard((board) =>
      harness.store.renewLease(board, taskId, WORKER_A, midway)
    );

    const justPastOriginal = new Date(Date.now() + harness.store.LEASE_DURATION_MS + 1_000);
    const reaped = await harness.store.withBoard((board) =>
      harness.store.reapExpiredLeases(board, justPastOriginal)
    );
    expect(reaped).toHaveLength(0);
  });
});

describe('persistence', () => {
  it('resumes the board from disk in a new module instance', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness, 'Survives a restart');
    const version = (await harness.store.readBoard()).tasks[0].version;
    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'claimed before the restart')
    );

    const file = harness.store.boardFilePath();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).tasks).toHaveLength(1);

    // Simulate a process restart against the same data directory.
    const reloaded = await reopenBoard(harness.dir);
    const board = await reloaded.readBoard();
    expect(board.tasks[0].title).toBe('Survives a restart');
    expect(board.tasks[0].status).toBe('claimed');
    // A reloaded board is never mid-run: the loop lives in memory, not on disk.
    expect(board.run.running).toBe(false);
  });

  it('does not write a stale snapshot back over newer work', async () => {
    harness = await freshBoard();
    await seedReadyTask(harness, 'Planned work');

    // A second holder of the board - in production, another Next.js route
    // bundle - reads it, then work happens, then that holder writes. Its write
    // must build on what actually happened rather than on what it first saw.
    const other = await reopenBoard(harness.dir);
    await other.readBoard();

    const viaFirst = await reopenBoard(harness.dir);
    await viaFirst.withBoard((board) => {
      board.tasks[0].title = 'Work that happened afterwards';
    });

    await other.withBoard((board) => {
      board.run.ticks += 1;
    });

    const final = await reopenBoard(harness.dir);
    const board = await final.readBoard();
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0].title).toBe('Work that happened afterwards');
  });
});

describe('audit trail', () => {
  it('records the actor and their reasoning for every change', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const version = (await harness.store.readBoard()).tasks[0].version;

    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'It was the only unblocked item.')
    );
    await harness.store.withBoard((board) =>
      harness.store.transitionTask(board, taskId, WORKER_A, 'in_progress', 'Starting work.')
    );
    await harness.human.reprioritiseTask(taskId, 1, 'Customer escalated this.');

    const board = await harness.store.readBoard();
    const claim = board.audit.find((event) => event.action === 'task.claimed');
    expect(claim?.actorId).toBe(WORKER_A.id);
    expect(claim?.reasoning).toBe('It was the only unblocked item.');
    expect(claim?.before).toMatchObject({ status: 'ready' });
    expect(claim?.after).toMatchObject({ status: 'claimed' });

    const reprioritise = board.audit.find((event) => event.action === 'task.reprioritised');
    expect(reprioritise?.actorRole).toBe('human');
    expect(reprioritise?.reasoning).toBe('Customer escalated this.');
    expect(reprioritise?.before).toMatchObject({ priority: 3 });
    expect(reprioritise?.after).toMatchObject({ priority: 1 });
  });

  it('caps the trail so a long-lived board cannot grow without bound', async () => {
    harness = await freshBoard();
    await harness.store.withBoard((board) => {
      for (let index = 0; index < harness.store.MAX_AUDIT_EVENTS + 50; index += 1) {
        harness.store.appendAudit(board, {
          action: 'agent.status',
          actor: WORKER_A,
          summary: 'noise ' + index,
          reasoning: 'filler',
        });
      }
    });
    const board = await harness.store.readBoard();
    expect(board.audit).toHaveLength(harness.store.MAX_AUDIT_EVENTS);
    // The cap drops the oldest entries, keeping the most recent history.
    expect(board.audit.at(-1)?.summary).toContain(String(harness.store.MAX_AUDIT_EVENTS + 49));
  });
});

describe('operator control', () => {
  it('takes a held task off an agent when reassigning it', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const version = (await harness.store.readBoard()).tasks[0].version;
    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'claimed')
    );

    await harness.human.reassignTask(taskId, WORKER_B.id, 'B has the context for this.');

    const board = await harness.store.readBoard();
    expect(board.tasks[0].assignedAgentId).toBe(WORKER_B.id);
    expect(board.tasks[0].lease).toBeNull();
    expect(board.tasks[0].status).toBe('ready');

    const agentA = board.agents.find((agent) => agent.id === WORKER_A.id);
    expect(agentA?.currentTaskId).toBeNull();
  });

  it('lets the operator move a held task despite the lease', async () => {
    harness = await freshBoard();
    const taskId = await seedReadyTask(harness);
    const version = (await harness.store.readBoard()).tasks[0].version;
    await harness.store.withBoard((board) =>
      harness.store.claimTask(board, taskId, WORKER_A, version, 'claimed')
    );

    const moved = await harness.human.moveTask(taskId, 'cancelled', 'No longer needed.');
    expect(moved.status).toBe('cancelled');
  });

  it('unblocks dependents as soon as a dependency is marked done', async () => {
    harness = await freshBoard();
    const first = await seedReadyTask(harness, 'First');
    const second = await harness.human.addManualTask(
      'obj_1',
      { title: 'Second', details: '' },
      'follow-up work'
    );
    await harness.human.setDependencies(second.id, [first], 'Second needs First.');

    let board = await harness.store.readBoard();
    expect(board.tasks.find((task) => task.id === second.id)?.status).toBe('blocked');

    await harness.human.moveTask(first, 'done', 'Finished by hand.');

    board = await harness.store.readBoard();
    expect(board.tasks.find((task) => task.id === second.id)?.status).toBe('ready');
  });
});
