/**
 * Pure lifecycle rules for work items.
 *
 * Nothing in here touches storage: these functions decide whether a change is
 * legal, and the store applies it. Keeping the rules pure means the mutual
 * exclusion guarantees can be tested without a filesystem or a running board.
 */
import {
  ALLOWED_TRANSITIONS,
  HELD_STATUSES,
  TERMINAL_STATUSES,
  type Task,
  type TaskStatus,
} from '@/lib/agentic/types';

export class LifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isHeld(status: TaskStatus): boolean {
  return HELD_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) {
    return true;
  }
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new LifecycleError(
      'illegal_transition',
      `Cannot move a task from "${from}" to "${to}".`
    );
  }
}

/** True when every dependency of `task` has reached `done`. */
export function dependenciesSatisfied(task: Task, all: Task[]): boolean {
  if (task.dependsOn.length === 0) {
    return true;
  }
  const byId = new Map(all.map((item) => [item.id, item]));
  return task.dependsOn.every((depId) => {
    const dep = byId.get(depId);
    // A dependency that no longer exists cannot block work forever.
    if (!dep) {
      return true;
    }
    return dep.status === 'done';
  });
}

/** Dependencies that are not yet done, for explaining why an item is blocked. */
export function unmetDependencies(task: Task, all: Task[]): Task[] {
  const byId = new Map(all.map((item) => [item.id, item]));
  return task.dependsOn
    .map((depId) => byId.get(depId))
    .filter((dep): dep is Task => Boolean(dep) && dep!.status !== 'done');
}

export function isLeaseExpired(task: Task, now: Date = new Date()): boolean {
  if (!task.lease) {
    return false;
  }
  return new Date(task.lease.expiresAt).getTime() <= now.getTime();
}

/**
 * Whether `agentId` is allowed to claim `task` right now.
 *
 * This is the single gate that enforces "one agent per item": a task must be
 * `ready`, unheld (or holding an expired lease), and either unassigned or
 * assigned to this very agent by a human.
 */
export function claimability(
  task: Task,
  agentId: string,
  all: Task[],
  now: Date = new Date()
): { ok: true } | { ok: false; reason: string } {
  if (isTerminal(task.status)) {
    return { ok: false, reason: `Task is ${task.status}.` };
  }
  if (task.lease && !isLeaseExpired(task, now)) {
    if (task.lease.agentId === agentId) {
      return { ok: false, reason: 'Task is already held by this agent.' };
    }
    return { ok: false, reason: `Task is held by ${task.lease.agentId}.` };
  }
  if (task.status !== 'ready') {
    return { ok: false, reason: `Task is ${task.status}, not ready.` };
  }
  if (task.assignedAgentId && task.assignedAgentId !== agentId) {
    return { ok: false, reason: `Task is reserved for ${task.assignedAgentId}.` };
  }
  if (!dependenciesSatisfied(task, all)) {
    return { ok: false, reason: 'Dependencies are not satisfied.' };
  }
  return { ok: true };
}

/**
 * The status a task should hold given its dependencies, used to keep the board
 * honest after any change. Only items that are not currently held and not
 * finished get recomputed, so this never yanks work out from under an agent.
 */
export function derivedStatus(task: Task, all: Task[]): TaskStatus {
  if (isTerminal(task.status) || isHeld(task.status) || task.status === 'failed') {
    return task.status;
  }
  const satisfied = dependenciesSatisfied(task, all);
  if (satisfied && (task.status === 'blocked' || task.status === 'planned')) {
    return 'ready';
  }
  if (!satisfied && (task.status === 'ready' || task.status === 'planned')) {
    return 'blocked';
  }
  return task.status;
}

/**
 * Queue order the workers pull from: human priority first, then plan rank, then
 * creation time. Reprioritising an item in the UI therefore changes what the
 * next agent picks up, without touching the agents themselves.
 */
export function queueOrder(a: Task, b: Task): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * The next task `agentId` should work, or null if nothing is available.
 * Human-pinned assignments win over the general queue so a reassignment takes
 * effect on the very next pull.
 */
export function selectNextTask(
  tasks: Task[],
  agentId: string,
  now: Date = new Date()
): Task | null {
  const claimable = tasks
    .filter((task) => claimability(task, agentId, tasks, now).ok)
    .sort(queueOrder);

  const pinned = claimable.find((task) => task.assignedAgentId === agentId);
  return pinned ?? claimable[0] ?? null;
}

/**
 * Detects dependency cycles, which would otherwise leave every task in the
 * cycle permanently blocked. Returns the ids taking part in a cycle.
 */
export function findCycles(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const inCycle = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    const mark = state.get(id);
    if (mark === 'done') {
      return;
    }
    if (mark === 'visiting') {
      // Everything from the first sighting of `id` onwards forms the cycle.
      const start = stack.indexOf(id);
      stack.slice(start).forEach((member) => inCycle.add(member));
      return;
    }
    state.set(id, 'visiting');
    const task = byId.get(id);
    for (const depId of task?.dependsOn ?? []) {
      if (byId.has(depId)) {
        visit(depId, [...stack, id]);
      }
    }
    state.set(id, 'done');
  };

  tasks.forEach((task) => visit(task.id, []));
  return [...inCycle];
}

/**
 * Removes dependency edges that take part in a cycle, so a bad plan degrades
 * into a runnable one instead of deadlocking the board.
 */
export function breakCycles(tasks: Task[]): Task[] {
  const cyclic = new Set(findCycles(tasks));
  if (cyclic.size === 0) {
    return tasks;
  }
  return tasks.map((task) =>
    cyclic.has(task.id)
      ? { ...task, dependsOn: task.dependsOn.filter((depId) => !cyclic.has(depId)) }
      : task
  );
}
