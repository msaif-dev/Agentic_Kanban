/**
 * The autonomous run loop.
 *
 * A pool of worker agents each repeat the same cycle independently: look at the
 * board, pick the highest-priority item they are allowed to take, claim it,
 * work it, release it. Nobody hands work out - the queue and the claim protocol
 * do all the coordination, which is what lets a single objective move from plan
 * to finished board without a person assigning individual pieces.
 *
 * Two invariants the loop depends on and never breaks:
 *
 *  - The brain call (slow, networked) always happens *outside* the board mutex.
 *  - Every board read that leads to a claim carries the task `version` it read,
 *    so a claim decided against stale state is rejected rather than applied.
 */
import { getBrain, type WorkInput } from '@/lib/agentic/brain';
import { LifecycleError, selectNextTask } from '@/lib/agentic/lifecycle';
import { nowIso } from '@/lib/agentic/ids';
import { runPlanningPass } from '@/lib/agentic/planner';
import {
  LEASE_DURATION_MS,
  appendAudit,
  claimTask,
  readBoard,
  reapExpiredLeases,
  recomputeReadiness,
  releaseTask,
  renewLease,
  setAgentActivity,
  transitionTask,
  upsertAgent,
  withBoard,
} from '@/lib/agentic/store';
import { HUMAN_ACTOR, type Actor, type Task } from '@/lib/agentic/types';

/** Pause between a worker's polls when it found nothing to do. */
const IDLE_POLL_MS = 700;

/** Pause between polls when the worker just finished something. */
const BUSY_POLL_MS = 150;

/** How often a working agent extends its lease. */
const RENEW_INTERVAL_MS = Math.floor(LEASE_DURATION_MS / 3);

/** A task that fails this many times is left in `failed` for a person to look at. */
const MAX_ATTEMPTS = 3;

export const MIN_WORKERS = 1;
export const MAX_WORKERS = 6;

function workerActor(index: number): Actor {
  return {
    id: 'agent-worker-' + (index + 1),
    name: 'Worker ' + (index + 1),
    role: 'worker',
  };
}

/**
 * Runs the worker pool. A single instance lives per process; in Next.js dev the
 * module can be re-evaluated on hot reload, so the instance is parked on
 * `globalThis` to avoid ending up with two pools driving one board.
 */
export class Orchestrator {
  private running = false;

  private loops: Promise<void>[] = [];

  private generation = 0;

  isRunning(): boolean {
    return this.running;
  }

  /** Starts the pool. Idempotent: starting an already-running pool resizes it. */
  async start(workerCount: number): Promise<void> {
    const count = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, Math.round(workerCount)));

    if (this.running) {
      await this.stop('Resizing the worker pool.');
    }

    this.running = true;
    this.generation += 1;
    const generation = this.generation;

    await withBoard((board) => {
      board.run = {
        running: true,
        workerCount: count,
        startedAt: nowIso(),
        stoppedAt: null,
        ticks: board.run.ticks,
        lastError: null,
      };
      for (let index = 0; index < count; index += 1) {
        const actor = workerActor(index);
        upsertAgent(board, {
          id: actor.id,
          name: actor.name,
          role: 'worker',
          status: 'idle',
          currentTaskId: null,
          activity: 'Waiting for work.',
          tasksCompleted: 0,
          lastSeenAt: nowIso(),
        });
      }
      appendAudit(board, {
        action: 'run.started',
        actor: HUMAN_ACTOR,
        summary: 'Run started with ' + count + ' worker agent(s).',
        reasoning: 'Operator started the autonomous run.',
        after: { workerCount: count },
      });
    });

    this.loops = Array.from({ length: count }, (_unused, index) =>
      this.workerLoop(workerActor(index), generation)
    );
  }

  /** Stops the pool and waits for in-flight work to unwind. */
  async stop(reason = 'Operator stopped the run.'): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    const loops = this.loops;
    this.loops = [];
    await Promise.allSettled(loops);

    await withBoard((board) => {
      board.run.running = false;
      board.run.stoppedAt = nowIso();
      board.agents
        .filter((agent) => agent.role === 'worker')
        .forEach((agent) => {
          agent.status = 'stopped';
          agent.activity = 'Run stopped.';
        });
      appendAudit(board, {
        action: 'run.stopped',
        actor: HUMAN_ACTOR,
        summary: 'Run stopped.',
        reasoning: reason,
      });
    });
  }

  /**
   * Runs exactly one claim-work-release cycle for one worker, without starting
   * the pool. This is what the UI's "Step" control uses, and what the tests
   * drive, since it makes progress deterministic and observable.
   */
  async step(actor: Actor = workerActor(0)): Promise<Task | null> {
    await withBoard((board) => {
      upsertAgent(board, {
        id: actor.id,
        name: actor.name,
        role: 'worker',
        status: 'idle',
        currentTaskId: null,
        activity: 'Stepping.',
        tasksCompleted: 0,
        lastSeenAt: nowIso(),
      });
    });
    return this.runOnce(actor);
  }

  /** Plans any objective that has been submitted but not yet decomposed. */
  async planPending(): Promise<void> {
    const board = await readBoard();
    const pending = board.objectives.filter(
      (objective) =>
        objective.status === 'draft' &&
        !board.tasks.some((task) => task.objectiveId === objective.id)
    );
    for (const objective of pending) {
      await runPlanningPass(objective.id);
    }
  }

  private async workerLoop(actor: Actor, generation: number): Promise<void> {
    while (this.running && this.generation === generation) {
      let worked: Task | null = null;
      try {
        // Any worker will run a pending planning pass, so a goal submitted
        // mid-run gets decomposed without the operator doing anything.
        await this.planPending();
        worked = await this.runOnce(actor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await withBoard((board) => {
          board.run.lastError = message;
          setAgentActivity(board, actor.id, 'error', message);
        });
      }
      await delay(worked ? BUSY_POLL_MS : IDLE_POLL_MS);
    }
  }

  /**
   * One full cycle: select, claim, work, release. Returns the task worked, or
   * null when there was nothing this agent could take.
   */
  private async runOnce(actor: Actor): Promise<Task | null> {
    // Housekeeping first: reclaim abandoned leases and refresh readiness so the
    // selection below sees an accurate board.
    await withBoard((board) => {
      board.run.ticks += 1;
      reapExpiredLeases(board);
      recomputeReadiness(board);
    });

    const snapshot = await readBoard();
    const candidate = selectNextTask(snapshot.tasks, actor.id);
    if (!candidate) {
      await withBoard((board) => setAgentActivity(board, actor.id, 'idle', 'No claimable work.'));
      return null;
    }

    const objective = snapshot.objectives.find((item) => item.id === candidate.objectiveId);
    const upstreamResults = candidate.dependsOn
      .map((depId) => snapshot.tasks.find((task) => task.id === depId))
      .filter((task): task is Task => Boolean(task?.result))
      .map((task) => ({ title: task.title, summary: task.result!.summary }));

    // Claim with the exact version we just read. If a human reprioritised the
    // item or another worker got there first, this throws and we simply retry
    // on the next cycle against fresh state.
    let claimed: Task;
    try {
      claimed = await withBoard((board) =>
        structuredClone(
          claimTask(
            board,
            candidate.id,
            actor,
            candidate.version,
            candidate.dependsOn.length
              ? 'Highest-priority item whose ' +
                  candidate.dependsOn.length +
                  ' dependency(ies) are all satisfied.'
              : 'Highest-priority unblocked item in the queue.'
          )
        )
      );
    } catch (error) {
      if (error instanceof LifecycleError) {
        // Losing a race is normal and expected, not a failure of the run.
        await withBoard((board) =>
          setAgentActivity(board, actor.id, 'idle', 'Lost claim race: ' + error.message)
        );
        return null;
      }
      throw error;
    }

    await withBoard((board) =>
      transitionTask(
        board,
        claimed.id,
        actor,
        'in_progress',
        'Claim held; starting work on "' + claimed.title + '".'
      )
    );

    // Keep the lease alive while the brain works, so a slow task is not reaped
    // out from under the agent that is legitimately working it.
    const renewer = setInterval(() => {
      void withBoard((board) => {
        try {
          renewLease(board, claimed.id, actor);
        } catch {
          // The task moved on; the interval is cleared just below.
        }
      });
    }, RENEW_INTERVAL_MS);

    try {
      const input: WorkInput = {
        goal: objective?.goal ?? claimed.title,
        title: claimed.title,
        details: claimed.details,
        acceptanceCriteria: claimed.acceptanceCriteria,
        upstreamResults,
        attempt: claimed.attempts,
      };

      const result = await getBrain().work(input);

      await withBoard((board) => {
        const destination = result.needsReview ? 'review' : 'done';
        transitionTask(board, claimed.id, actor, destination, result.reasoning, {
          result: {
            summary: result.summary,
            output: result.output,
            producedBy: actor.name,
            completedAt: nowIso(),
          },
        });
        if (destination === 'review') {
          // Review is a resting state for a person, so the claim is dropped and
          // the item is left visible rather than silently held.
          setAgentActivity(board, actor.id, 'idle', 'Sent "' + claimed.title + '" for review.');
        }
      });

      return claimed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withBoard((board) => {
        const task = board.tasks.find((item) => item.id === claimed.id);
        const exhausted = (task?.attempts ?? 0) >= MAX_ATTEMPTS;
        if (exhausted) {
          transitionTask(
            board,
            claimed.id,
            actor,
            'failed',
            'Failed after ' + MAX_ATTEMPTS + ' attempts: ' + message
          );
        } else {
          releaseTask(
            board,
            claimed.id,
            actor,
            'Attempt ' + (task?.attempts ?? 1) + ' failed (' + message + '); returned to the queue for a retry.'
          );
        }
      });
      return null;
    } finally {
      clearInterval(renewer);
    }
  }
}

// Survive Next.js dev hot reloads: one pool per process, not one per module copy.
const globalRef = globalThis as typeof globalThis & { __agenticOrchestrator?: Orchestrator };

export function getOrchestrator(): Orchestrator {
  if (!globalRef.__agenticOrchestrator) {
    globalRef.__agenticOrchestrator = new Orchestrator();
  }
  return globalRef.__agenticOrchestrator;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
