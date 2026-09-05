/**
 * The planning pass.
 *
 * Turns one high-level objective into ordered work items with real dependencies,
 * so downstream tasks wait for the results they actually need. The pass is
 * idempotent per objective: re-planning an objective that already has tasks
 * leaves human-pinned items alone.
 */
import { getBrain, type PlanStep } from '@/lib/agentic/brain';
import { breakCycles, findCycles } from '@/lib/agentic/lifecycle';
import { newId, nowIso } from '@/lib/agentic/ids';
import {
  appendAudit,
  createTask,
  readBoard,
  recomputeReadiness,
  setAgentActivity,
  upsertAgent,
  withBoard,
} from '@/lib/agentic/store';
import type { Actor, Objective, Task, TaskPriority } from '@/lib/agentic/types';

export const PLANNER_AGENT: Actor = {
  id: 'agent-planner',
  name: 'Planner',
  role: 'planner',
};

/** Ceiling on plan size, so one objective cannot flood the board. */
export const MAX_PLAN_STEPS = 8;

/** Registers the planner in the agent roster if it is not there yet. */
export async function ensurePlannerAgent(): Promise<void> {
  await withBoard((board) => {
    upsertAgent(board, {
      id: PLANNER_AGENT.id,
      name: PLANNER_AGENT.name,
      role: 'planner',
      status: 'idle',
      currentTaskId: null,
      activity: null,
      tasksCompleted: 0,
      lastSeenAt: nowIso(),
    });
  });
}

/** Creates a new objective in `draft`, ready to be planned. */
export async function createObjective(goal: string, actor: Actor): Promise<Objective> {
  const trimmed = goal.trim();
  if (!trimmed) {
    throw new Error('An objective needs a goal.');
  }

  return withBoard((board) => {
    const objective: Objective = {
      id: newId('obj'),
      goal: trimmed,
      status: 'draft',
      planRationale: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    board.objectives.push(objective);
    appendAudit(board, {
      action: 'objective.created',
      actor,
      objectiveId: objective.id,
      summary: 'New objective: "' + trimmed + '".',
      reasoning: 'Submitted to the board for decomposition.',
      after: { goal: trimmed },
    });
    return objective;
  });
}

/**
 * Runs the planning pass for one objective.
 *
 * The brain call happens outside the board mutex - it can take many seconds, and
 * holding the write lock across it would stall every worker on the board.
 */
export async function runPlanningPass(objectiveId: string): Promise<Task[]> {
  await ensurePlannerAgent();

  const snapshot = await readBoard();
  const objective = snapshot.objectives.find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error('No objective with id "' + objectiveId + '".');
  }

  const alreadyPlanned = snapshot.tasks.filter((task) => task.objectiveId === objectiveId);
  if (alreadyPlanned.length > 0) {
    // Nothing to do; re-planning would duplicate work the agents may already hold.
    return [];
  }

  await withBoard((board) => {
    const target = board.objectives.find((item) => item.id === objectiveId);
    if (target) {
      target.status = 'planning';
      target.updatedAt = nowIso();
    }
    setAgentActivity(board, PLANNER_AGENT.id, 'planning', 'Decomposing "' + objective.goal + '"');
    appendAudit(board, {
      action: 'plan.started',
      actor: PLANNER_AGENT,
      objectiveId,
      summary: 'Planning pass started for "' + objective.goal + '".',
      reasoning: 'An objective was submitted with no work items, so it needs decomposing before any worker can act.',
    });
  });

  const brain = getBrain();

  let plan;
  try {
    plan = await brain.plan(objective.goal, MAX_PLAN_STEPS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withBoard((board) => {
      const target = board.objectives.find((item) => item.id === objectiveId);
      if (target) {
        target.status = 'failed';
        target.updatedAt = nowIso();
      }
      setAgentActivity(board, PLANNER_AGENT.id, 'error', 'Planning failed: ' + message);
      appendAudit(board, {
        action: 'plan.failed',
        actor: PLANNER_AGENT,
        objectiveId,
        summary: 'Planning pass failed.',
        reasoning: message,
      });
    });
    throw error;
  }

  return withBoard((board) => {
    const target = board.objectives.find((item) => item.id === objectiveId);
    const steps = sanitiseSteps(plan.steps);

    // Plan keys are local to the plan; map them onto the ids the board assigns.
    const keyToId = new Map<string, string>();
    const created: Task[] = [];

    steps.forEach((step, index) => {
      const task = createTask(
        board,
        PLANNER_AGENT,
        {
          objectiveId,
          title: step.title,
          details: step.details,
          acceptanceCriteria: step.acceptanceCriteria,
          priority: step.priority as TaskPriority,
          rank: index,
        },
        step.dependsOn.length
          ? 'Planned as step ' + (index + 1) + ', waiting on ' + step.dependsOn.length + ' upstream item(s).'
          : 'Planned as step ' + (index + 1) + '; no upstream dependencies, so it can start immediately.'
      );
      keyToId.set(step.key, task.id);
      created.push(task);
    });

    // Second pass: dependencies can only be resolved once every id exists.
    created.forEach((task, index) => {
      const step = steps[index];
      task.dependsOn = step.dependsOn
        .map((key) => keyToId.get(key))
        .filter((id): id is string => Boolean(id) && id !== task.id);
    });

    const cyclic = findCycles(created);
    if (cyclic.length > 0) {
      const repaired = breakCycles(created);
      repaired.forEach((fixed, index) => {
        created[index].dependsOn = fixed.dependsOn;
      });
      appendAudit(board, {
        action: 'plan.completed',
        actor: PLANNER_AGENT,
        objectiveId,
        summary: 'Removed ' + cyclic.length + ' circular dependency link(s) from the plan.',
        reasoning:
          'The proposed ordering contained a cycle, which would have left every task in it permanently blocked. The offending edges were dropped so the work can proceed.',
        after: { cyclicTasks: cyclic },
      });
    }

    if (target) {
      target.status = 'active';
      target.planRationale = plan.rationale;
      target.updatedAt = nowIso();
    }

    recomputeReadiness(board);
    setAgentActivity(board, PLANNER_AGENT.id, 'idle', 'Plan ready: ' + created.length + ' work items.');

    appendAudit(board, {
      action: 'plan.completed',
      actor: PLANNER_AGENT,
      objectiveId,
      summary: 'Decomposed the objective into ' + created.length + ' work items.',
      reasoning: plan.rationale,
      after: {
        steps: created.map((task) => ({
          id: task.id,
          title: task.title,
          dependsOn: task.dependsOn,
          priority: task.priority,
        })),
      },
    });

    return created.map((task) => structuredClone(task));
  });
}

/** Convenience for the API: create an objective and immediately plan it. */
export async function createAndPlan(goal: string, actor: Actor): Promise<{ objective: Objective; tasks: Task[] }> {
  const objective = await createObjective(goal, actor);
  const tasks = await runPlanningPass(objective.id);
  return { objective, tasks };
}

/**
 * Defends against a malformed plan: drops steps with no title, de-duplicates
 * keys, and discards dependency references that point at nothing.
 */
function sanitiseSteps(steps: PlanStep[]): PlanStep[] {
  const seen = new Set<string>();
  const cleaned: PlanStep[] = [];

  steps.forEach((step, index) => {
    const title = (step.title ?? '').trim();
    if (!title) {
      return;
    }
    let key = (step.key ?? '').trim() || 's' + (index + 1);
    while (seen.has(key)) {
      key = key + '_' + (index + 1);
    }
    seen.add(key);
    cleaned.push({
      key,
      title,
      details: (step.details ?? '').trim(),
      acceptanceCriteria: (step.acceptanceCriteria ?? []).filter((item) => item && item.trim()),
      dependsOn: [...new Set(step.dependsOn ?? [])],
      priority: Math.min(5, Math.max(1, Math.round(step.priority ?? 3))),
    });
  });

  const validKeys = new Set(cleaned.map((step) => step.key));
  return cleaned.map((step) => ({
    ...step,
    dependsOn: step.dependsOn.filter((key) => validKeys.has(key) && key !== step.key),
  }));
}
