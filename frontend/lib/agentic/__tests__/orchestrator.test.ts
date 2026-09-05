// @vitest-environment node
// These exercise server-side modules; jsdom would make the SDK refuse to load.
import { afterEach, describe, expect, it } from 'vitest';
import { freshBoard, type Harness } from '@/lib/agentic/__tests__/harness';
import type { Brain, PlanOutput, WorkInput, WorkOutput } from '@/lib/agentic/brain';

let harness: Harness;

afterEach(async () => {
  await harness?.cleanup();
});

/**
 * A scripted brain, so a whole objective can run to completion deterministically
 * and without network access. It records the order work actually happened in,
 * which is what the dependency assertions below inspect.
 */
class ScriptedBrain implements Brain {
  readonly name = 'scripted';

  readonly workedTitles: string[] = [];

  constructor(
    private readonly plan_: PlanOutput,
    private readonly options: { failTitles?: Set<string>; reviewTitles?: Set<string> } = {}
  ) {}

  async plan(): Promise<PlanOutput> {
    return this.plan_;
  }

  async work(input: WorkInput): Promise<WorkOutput> {
    if (this.options.failTitles?.has(input.title)) {
      throw new Error('scripted failure for ' + input.title);
    }
    this.workedTitles.push(input.title);
    return {
      summary: 'Did ' + input.title,
      output: 'output of ' + input.title,
      reasoning: 'scripted worker reasoning',
      needsReview: this.options.reviewTitles?.has(input.title) ?? false,
    };
  }
}

const LINEAR_PLAN: PlanOutput = {
  rationale: 'Three steps that must happen in order.',
  steps: [
    {
      key: 's1',
      title: 'Gather requirements',
      details: 'Collect what is needed.',
      acceptanceCriteria: ['Requirements written down'],
      dependsOn: [],
      priority: 1,
    },
    {
      key: 's2',
      title: 'Build the thing',
      details: 'Construct it from the requirements.',
      acceptanceCriteria: ['It exists'],
      dependsOn: ['s1'],
      priority: 2,
    },
    {
      key: 's3',
      title: 'Verify the thing',
      details: 'Check it against the requirements.',
      acceptanceCriteria: ['Checked'],
      dependsOn: ['s2'],
      priority: 2,
    },
  ],
};

/**
 * Drives `step()` until nothing on the board is claimable any more.
 *
 * A step that returns null is not the end of the run - a failed attempt returns
 * the item to the queue for a retry - so the stopping condition is the board
 * having no claimable work left, not one unproductive step.
 */
async function drain(h: Harness, maxSteps = 60): Promise<void> {
  const actor = { id: 'agent-worker-1', name: 'Worker 1', role: 'worker' as const };
  const orchestrator = h.orchestrator.getOrchestrator();

  for (let index = 0; index < maxSteps; index += 1) {
    await orchestrator.step(actor);
    const board = await h.store.readBoard();
    if (!h.lifecycle.selectNextTask(board.tasks, actor.id)) {
      return;
    }
  }
}

describe('planning pass', () => {
  it('turns an objective into ordered tasks with real dependencies', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(new ScriptedBrain(LINEAR_PLAN));

    const { objective, tasks } = await harness.planner.createAndPlan(
      'Ship the reporting feature',
      harness.types.HUMAN_ACTOR
    );

    expect(tasks).toHaveLength(3);
    expect(objective.goal).toBe('Ship the reporting feature');

    const board = await harness.store.readBoard();
    const byTitle = new Map(board.tasks.map((task) => [task.title, task]));

    // Plan-local keys were resolved to real board ids.
    expect(byTitle.get('Build the thing')?.dependsOn).toEqual([
      byTitle.get('Gather requirements')?.id,
    ]);
    expect(byTitle.get('Verify the thing')?.dependsOn).toEqual([byTitle.get('Build the thing')?.id]);

    // Only the item with no dependencies is workable straight away.
    expect(byTitle.get('Gather requirements')?.status).toBe('ready');
    expect(byTitle.get('Build the thing')?.status).toBe('blocked');
    expect(byTitle.get('Verify the thing')?.status).toBe('blocked');

    const planned = board.objectives.find((item) => item.id === objective.id);
    expect(planned?.status).toBe('active');
    expect(planned?.planRationale).toBe(LINEAR_PLAN.rationale);
  });

  it('records the plan and its rationale on the audit trail', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(new ScriptedBrain(LINEAR_PLAN));
    await harness.planner.createAndPlan('Ship it', harness.types.HUMAN_ACTOR);

    const board = await harness.store.readBoard();
    const completed = board.audit.find((event) => event.action === 'plan.completed');
    expect(completed?.actorRole).toBe('planner');
    expect(completed?.reasoning).toBe(LINEAR_PLAN.rationale);
  });

  it('does not re-plan an objective that already has work items', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(new ScriptedBrain(LINEAR_PLAN));
    const { objective } = await harness.planner.createAndPlan('Ship it', harness.types.HUMAN_ACTOR);

    const again = await harness.planner.runPlanningPass(objective.id);
    expect(again).toEqual([]);
    expect((await harness.store.readBoard()).tasks).toHaveLength(3);
  });

  it('repairs a plan that contains a dependency cycle', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(
      new ScriptedBrain({
        rationale: 'Cyclic by mistake.',
        steps: [
          { key: 'a', title: 'A', details: '', acceptanceCriteria: [], dependsOn: ['b'], priority: 1 },
          { key: 'b', title: 'B', details: '', acceptanceCriteria: [], dependsOn: ['a'], priority: 1 },
        ],
      })
    );

    await harness.planner.createAndPlan('Impossible goal', harness.types.HUMAN_ACTOR);
    const board = await harness.store.readBoard();

    expect(harness.lifecycle.findCycles(board.tasks)).toEqual([]);
    // With the cycle broken, at least one item can actually be worked.
    expect(board.tasks.some((task) => task.status === 'ready')).toBe(true);
  });
});

describe('autonomous execution', () => {
  it('carries an objective from plan to finished board with no assignment', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain(LINEAR_PLAN);
    harness.brain.setBrain(brain);

    await harness.planner.createAndPlan('Ship the reporting feature', harness.types.HUMAN_ACTOR);
    await drain(harness);

    const board = await harness.store.readBoard();
    expect(board.tasks.every((task) => task.status === 'done')).toBe(true);
    expect(board.objectives[0].status).toBe('complete');

    // The dependency order was respected, not just recorded.
    expect(brain.workedTitles).toEqual([
      'Gather requirements',
      'Build the thing',
      'Verify the thing',
    ]);

    // Every finished item carries the result and the agent that produced it.
    board.tasks.forEach((task) => {
      expect(task.result?.producedBy).toBe('Worker 1');
      expect(task.result?.summary).toContain(task.title);
    });
  });

  it('leaves an item in review when the worker asks for a person', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(
      new ScriptedBrain(LINEAR_PLAN, { reviewTitles: new Set(['Verify the thing']) })
    );

    await harness.planner.createAndPlan('Ship it', harness.types.HUMAN_ACTOR);
    await drain(harness);

    const board = await harness.store.readBoard();
    const verify = board.tasks.find((task) => task.title === 'Verify the thing');
    expect(verify?.status).toBe('review');
    // Review is a resting state, so the claim is dropped for the reviewer.
    expect(verify?.lease).toBeNull();
    expect(board.objectives[0].status).toBe('active');
  });

  it('retries a failing item and gives up after the attempt limit', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(
      new ScriptedBrain(LINEAR_PLAN, { failTitles: new Set(['Gather requirements']) })
    );

    await harness.planner.createAndPlan('Ship it', harness.types.HUMAN_ACTOR);
    await drain(harness);

    const board = await harness.store.readBoard();
    const failing = board.tasks.find((task) => task.title === 'Gather requirements');
    expect(failing?.status).toBe('failed');
    expect(failing?.attempts).toBeGreaterThanOrEqual(3);

    // Downstream work correctly never started, because its input never arrived.
    expect(board.tasks.find((task) => task.title === 'Build the thing')?.status).toBe('blocked');

    const failure = board.audit.find((event) => event.action === 'task.failed');
    expect(failure?.reasoning).toContain('scripted failure');
  });

  it('runs independent items without inventing an order between them', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain({
      rationale: 'Two independent items.',
      steps: [
        { key: 'a', title: 'Left', details: '', acceptanceCriteria: [], dependsOn: [], priority: 2 },
        { key: 'b', title: 'Right', details: '', acceptanceCriteria: [], dependsOn: [], priority: 2 },
      ],
    });
    harness.brain.setBrain(brain);

    await harness.planner.createAndPlan('Two things', harness.types.HUMAN_ACTOR);

    const board = await harness.store.readBoard();
    expect(board.tasks.filter((task) => task.status === 'ready')).toHaveLength(2);

    await drain(harness);
    expect(brain.workedTitles.sort()).toEqual(['Left', 'Right']);
  });

  it('passes upstream results to the agent working a dependent item', async () => {
    harness = await freshBoard();
    const seen: WorkInput[] = [];

    class RecordingBrain extends ScriptedBrain {
      async work(input: WorkInput): Promise<WorkOutput> {
        seen.push(input);
        return super.work(input);
      }
    }

    harness.brain.setBrain(new RecordingBrain(LINEAR_PLAN));
    await harness.planner.createAndPlan('Ship it', harness.types.HUMAN_ACTOR);
    await drain(harness);

    const build = seen.find((input) => input.title === 'Build the thing');
    expect(build?.upstreamResults).toEqual([
      { title: 'Gather requirements', summary: 'Did Gather requirements' },
    ]);
  });
});

describe('the operator stays in control mid-run', () => {
  it('agents follow a reprioritised queue rather than the original plan order', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain({
      rationale: 'Three independent items, planned in order.',
      steps: [
        { key: 'a', title: 'First', details: '', acceptanceCriteria: [], dependsOn: [], priority: 3 },
        { key: 'b', title: 'Second', details: '', acceptanceCriteria: [], dependsOn: [], priority: 3 },
        { key: 'c', title: 'Third', details: '', acceptanceCriteria: [], dependsOn: [], priority: 3 },
      ],
    });
    harness.brain.setBrain(brain);

    await harness.planner.createAndPlan('Three things', harness.types.HUMAN_ACTOR);

    // The operator pulls the last item to the front before any work starts.
    const board = await harness.store.readBoard();
    const third = board.tasks.find((task) => task.title === 'Third')!;
    await harness.human.reprioritiseTask(third.id, 1, 'Customer is waiting on this one.');

    await drain(harness);

    expect(brain.workedTitles[0]).toBe('Third');
    const audit = (await harness.store.readBoard()).audit;
    const change = audit.find((event) => event.action === 'task.reprioritised');
    expect(change?.actorRole).toBe('human');
    expect(change?.reasoning).toBe('Customer is waiting on this one.');
  });

  it('agents pull in the order a reordered queue specifies', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain({
      rationale: 'Three independent items at the same priority.',
      steps: [
        { key: 'a', title: 'Alpha', details: '', acceptanceCriteria: [], dependsOn: [], priority: 2 },
        { key: 'b', title: 'Bravo', details: '', acceptanceCriteria: [], dependsOn: [], priority: 2 },
        { key: 'c', title: 'Charlie', details: '', acceptanceCriteria: [], dependsOn: [], priority: 2 },
      ],
    });
    harness.brain.setBrain(brain);
    await harness.planner.createAndPlan('Three things', harness.types.HUMAN_ACTOR);

    // This is what a drag-to-reorder in the UI sends: the whole lane's new order.
    const board = await harness.store.readBoard();
    const byTitle = new Map(board.tasks.map((task) => [task.title, task.id]));
    await harness.human.reorderQueue(
      [byTitle.get('Charlie')!, byTitle.get('Alpha')!, byTitle.get('Bravo')!],
      'Operator reordered the Ready queue.'
    );

    await drain(harness);

    expect(brain.workedTitles).toEqual(['Charlie', 'Alpha', 'Bravo']);

    const audit = (await harness.store.readBoard()).audit;
    const moved = audit.filter((event) => event.summary.includes('position'));
    expect(moved).not.toHaveLength(0);
    expect(moved[0].actorRole).toBe('human');
  });

  it('keeps priority above queue rank when the two disagree', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain({
      rationale: 'One urgent item planned last.',
      steps: [
        { key: 'a', title: 'Routine', details: '', acceptanceCriteria: [], dependsOn: [], priority: 3 },
        { key: 'b', title: 'Urgent', details: '', acceptanceCriteria: [], dependsOn: [], priority: 1 },
      ],
    });
    harness.brain.setBrain(brain);
    await harness.planner.createAndPlan('Two things', harness.types.HUMAN_ACTOR);

    // Put the routine item first in the queue; priority should still win.
    const board = await harness.store.readBoard();
    const byTitle = new Map(board.tasks.map((task) => [task.title, task.id]));
    await harness.human.reorderQueue(
      [byTitle.get('Routine')!, byTitle.get('Urgent')!],
      'Operator reordered the queue.'
    );

    await drain(harness);
    expect(brain.workedTitles).toEqual(['Urgent', 'Routine']);
  });

  it('sends a reassigned item to the agent the operator chose', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain({
      rationale: 'Two items.',
      steps: [
        { key: 'a', title: 'Alpha', details: '', acceptanceCriteria: [], dependsOn: [], priority: 1 },
        { key: 'b', title: 'Beta', details: '', acceptanceCriteria: [], dependsOn: [], priority: 3 },
      ],
    });
    harness.brain.setBrain(brain);
    await harness.planner.createAndPlan('Two things', harness.types.HUMAN_ACTOR);

    const orchestrator = harness.orchestrator.getOrchestrator();
    const workerTwo = { id: 'agent-worker-2', name: 'Worker 2', role: 'worker' as const };

    // Register worker 2, then reserve the low-priority item for it.
    await orchestrator.step(workerTwo);
    const beta = (await harness.store.readBoard()).tasks.find((task) => task.title === 'Beta')!;
    await harness.human.reassignTask(beta.id, workerTwo.id, 'Worker 2 handled the last one of these.');

    // Worker 2 takes its reserved item even though Alpha is higher priority.
    await orchestrator.step(workerTwo);
    const after = await harness.store.readBoard();
    const betaAfter = after.tasks.find((task) => task.id === beta.id);
    expect(betaAfter?.result?.producedBy).toBe('Worker 2');
  });

  it('keeps a human edit rather than reverting to the planned wording', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(new ScriptedBrain(LINEAR_PLAN));
    const { objective } = await harness.planner.createAndPlan('Ship it', harness.types.HUMAN_ACTOR);

    const target = (await harness.store.readBoard()).tasks[0];
    await harness.human.editTask(
      target.id,
      { title: 'Gather requirements from support tickets' },
      'Narrowing the scope to what we actually need.'
    );

    // A second planning pass must not overwrite the operator's wording.
    await harness.planner.runPlanningPass(objective.id);

    const board = await harness.store.readBoard();
    const edited = board.tasks.find((task) => task.id === target.id);
    expect(edited?.title).toBe('Gather requirements from support tickets');
    expect(edited?.pinnedByHuman).toBe(true);
  });
});

describe('run controls', () => {
  it('starts and stops the worker pool and records both on the trail', async () => {
    harness = await freshBoard();
    harness.brain.setBrain(new ScriptedBrain(LINEAR_PLAN));
    const orchestrator = harness.orchestrator.getOrchestrator();

    await orchestrator.start(2);
    expect(orchestrator.isRunning()).toBe(true);

    await orchestrator.stop();
    expect(orchestrator.isRunning()).toBe(false);

    const board = await harness.store.readBoard();
    expect(board.audit.some((event) => event.action === 'run.started')).toBe(true);
    expect(board.audit.some((event) => event.action === 'run.stopped')).toBe(true);
    expect(board.run.running).toBe(false);
  });

  it('finishes an objective with several workers running concurrently', async () => {
    harness = await freshBoard();
    const brain = new ScriptedBrain({
      rationale: 'A fan-out with a join.',
      steps: [
        { key: 'a', title: 'Base', details: '', acceptanceCriteria: [], dependsOn: [], priority: 1 },
        { key: 'b', title: 'Branch 1', details: '', acceptanceCriteria: [], dependsOn: ['a'], priority: 2 },
        { key: 'c', title: 'Branch 2', details: '', acceptanceCriteria: [], dependsOn: ['a'], priority: 2 },
        { key: 'd', title: 'Join', details: '', acceptanceCriteria: [], dependsOn: ['b', 'c'], priority: 2 },
      ],
    });
    harness.brain.setBrain(brain);
    await harness.planner.createAndPlan('Fan out and join', harness.types.HUMAN_ACTOR);

    const orchestrator = harness.orchestrator.getOrchestrator();
    await orchestrator.start(3);

    const deadline = Date.now() + 15_000;
    let board = await harness.store.readBoard();
    while (Date.now() < deadline && !board.tasks.every((task) => task.status === 'done')) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      board = await harness.store.readBoard();
    }
    await orchestrator.stop();

    expect(board.tasks.every((task) => task.status === 'done')).toBe(true);
    // Each item was worked exactly once despite three agents competing for them.
    expect(brain.workedTitles.slice().sort()).toEqual(['Base', 'Branch 1', 'Branch 2', 'Join']);
    // The join genuinely waited for both branches.
    expect(brain.workedTitles.indexOf('Join')).toBe(3);
  }, 20_000);
});
