/**
 * File-backed board storage.
 *
 * Two properties matter here and both are provided by this module rather than by
 * its callers:
 *
 *  1. **Durability** - the board is written to disk after every mutation, so a
 *     run that is stopped (or a process that dies) resumes from where it left
 *     off rather than from the original plan.
 *  2. **Mutual exclusion** - every mutation runs inside a single-writer async
 *     mutex and compares an optimistic `version` token, so two agents racing for
 *     the same item cannot both win.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LifecycleError,
  assertTransition,
  claimability,
  derivedStatus,
  isLeaseExpired,
} from '@/lib/agentic/lifecycle';
import { newId, nowIso } from '@/lib/agentic/ids';
import {
  type Actor,
  type Agent,
  type AuditAction,
  type AuditEvent,
  type BoardState,
  type Objective,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/agentic/types';

/** How long a claim is valid before the reaper may return the task to the queue. */
export const LEASE_DURATION_MS = 60_000;

/** Audit trail is capped so a long-lived board cannot grow without bound. */
export const MAX_AUDIT_EVENTS = 2_000;

const DATA_DIR = process.env.AGENTIC_DATA_DIR
  ? path.resolve(process.env.AGENTIC_DATA_DIR)
  : path.join(process.cwd(), '.data');

const BOARD_FILE = path.join(DATA_DIR, 'board.json');

export function emptyBoard(): BoardState {
  return {
    version: 1,
    objectives: [],
    tasks: [],
    agents: [],
    audit: [],
    run: {
      running: false,
      workerCount: 2,
      startedAt: null,
      stoppedAt: null,
      ticks: 0,
      lastError: null,
    },
    updatedAt: nowIso(),
  };
}

/** Fills in anything missing from an older on-disk board so upgrades do not crash. */
function normalise(raw: Partial<BoardState> | null): BoardState {
  const base = emptyBoard();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  return {
    ...base,
    ...raw,
    objectives: raw.objectives ?? [],
    tasks: (raw.tasks ?? []).map((task) => ({ ...task, version: task.version ?? 1 })),
    agents: raw.agents ?? [],
    audit: raw.audit ?? [],
    // A board reloaded from disk is never mid-run: the loop lives in memory.
    run: { ...base.run, ...(raw.run ?? {}), running: false },
  };
}

/**
 * Cache and mutex state.
 *
 * These live on `globalThis` rather than in module scope on purpose. Next.js
 * compiles each route into its own bundle, so a module-level cache would give
 * `/api/board` and `/api/tasks` separate copies of the board - and whichever
 * wrote last would clobber the other's work with its own stale snapshot. One
 * shared cell means one cache and, critically, one write mutex per process.
 */
type StoreCell = {
  cache: BoardState | null;
  writeChain: Promise<unknown>;
  /** mtime of the board file as of our last read or write. */
  mtimeMs: number;
};

const cell: StoreCell = ((globalThis as typeof globalThis & { __agenticStore?: StoreCell })
  .__agenticStore ??= {
  cache: null,
  writeChain: Promise.resolve(),
  mtimeMs: 0,
});

async function readFromDisk(): Promise<BoardState> {
  try {
    const contents = await fs.readFile(BOARD_FILE, 'utf8');
    return normalise(JSON.parse(contents) as Partial<BoardState>);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return emptyBoard();
    }
    if (error instanceof SyntaxError) {
      // A corrupt file should not take the board offline; keep it for forensics.
      await fs.rename(BOARD_FILE, BOARD_FILE + '.corrupt-' + Date.now()).catch(() => undefined);
      return emptyBoard();
    }
    throw error;
  }
}

async function writeToDisk(board: BoardState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a half-written board.
  const temp = BOARD_FILE + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify(board, null, 2), 'utf8');
  await fs.rename(temp, BOARD_FILE);
  // Record what we just wrote so the next read does not treat it as foreign.
  cell.mtimeMs = await currentMtime();
}

/**
 * The current board, re-reading from disk whenever the file has moved on since
 * we last touched it. The cache is an optimisation, never the source of truth:
 * anything else that writes the file - another process, an operator editing it,
 * a route bundle we do not share memory with - wins over what we hold.
 */
export async function loadBoard(): Promise<BoardState> {
  const mtimeMs = await currentMtime();
  if (cell.cache && mtimeMs === cell.mtimeMs) {
    return cell.cache;
  }
  cell.cache = await readFromDisk();
  cell.mtimeMs = mtimeMs;
  return cell.cache;
}

async function currentMtime(): Promise<number> {
  try {
    return (await fs.stat(BOARD_FILE)).mtimeMs;
  } catch {
    // No file yet: any cached board is the one we are about to create.
    return 0;
  }
}

/** Test seam: drops the in-memory cache so the next read hits disk. */
export function resetCache(): void {
  cell.cache = null;
  cell.mtimeMs = 0;
}

export function boardFilePath(): string {
  return BOARD_FILE;
}

/**
 * Runs `mutator` against the board under the write mutex and persists the result.
 * The mutator receives a draft it may mutate in place and returns whatever the
 * caller needs back.
 */
export async function withBoard<T>(mutator: (board: BoardState) => T | Promise<T>): Promise<T> {
  const run = cell.writeChain.then(async () => {
    // Re-read inside the mutex: the board may have changed since the caller
    // decided to make this change, and mutating a stale copy would write that
    // staleness back over whatever actually happened.
    const board = await loadBoard();
    const result = await mutator(board);
    board.updatedAt = nowIso();
    cell.cache = board;
    await writeToDisk(board);
    return result;
  });
  // Keep the chain alive even when this mutation rejects.
  cell.writeChain = run.catch(() => undefined);
  return run;
}

/** Read-only snapshot, deep-copied so callers cannot mutate the cache by accident. */
export async function readBoard(): Promise<BoardState> {
  const board = await loadBoard();
  return structuredClone(board);
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

type AuditInput = {
  action: AuditAction;
  actor: Actor;
  summary: string;
  reasoning: string;
  taskId?: string | null;
  objectiveId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/** Appends an audit event to the draft board. Callers are already inside the mutex. */
export function appendAudit(board: BoardState, input: AuditInput): AuditEvent {
  const event: AuditEvent = {
    id: newId('evt'),
    at: nowIso(),
    actorId: input.actor.id,
    actorName: input.actor.name,
    actorRole: input.actor.role,
    action: input.action,
    taskId: input.taskId ?? null,
    objectiveId: input.objectiveId ?? null,
    summary: input.summary,
    reasoning: input.reasoning,
    before: input.before ?? null,
    after: input.after ?? null,
  };
  board.audit.push(event);
  if (board.audit.length > MAX_AUDIT_EVENTS) {
    board.audit.splice(0, board.audit.length - MAX_AUDIT_EVENTS);
  }
  return event;
}

// ---------------------------------------------------------------------------
// Board maintenance
// ---------------------------------------------------------------------------

/**
 * Returns tasks whose lease has lapsed to the queue. Without this a worker that
 * dies mid-task would hold its claim forever and the objective would stall.
 */
export function reapExpiredLeases(board: BoardState, now: Date = new Date()): Task[] {
  const reaped: Task[] = [];
  for (const task of board.tasks) {
    if (!task.lease || !isLeaseExpired(task, now)) {
      continue;
    }
    const previousAgent = task.lease.agentId;
    const before = { status: task.status, lease: task.lease };
    task.lease = null;
    task.status = 'ready';
    task.version += 1;
    task.updatedAt = nowIso();
    reaped.push(task);

    const agent = board.agents.find((candidate) => candidate.id === previousAgent);
    if (agent && agent.currentTaskId === task.id) {
      agent.currentTaskId = null;
      agent.status = 'idle';
      agent.activity = 'Lease expired; released task.';
    }

    appendAudit(board, {
      action: 'task.lease_expired',
      actor: { id: 'system', name: 'Board supervisor', role: 'planner' },
      taskId: task.id,
      objectiveId: task.objectiveId,
      summary: 'Lease held by ' + previousAgent + ' expired; task returned to the queue.',
      reasoning:
        'The holding agent did not renew its lease within the allowed window, so the item was released to keep the objective moving.',
      before,
      after: { status: task.status, lease: null },
    });
  }
  return reaped;
}

/**
 * Recomputes ready/blocked from current dependencies. Called after any change
 * that could unblock work, so completing a task immediately frees its dependents.
 */
export function recomputeReadiness(board: BoardState): Task[] {
  const changed: Task[] = [];
  for (const task of board.tasks) {
    const next = derivedStatus(task, board.tasks);
    if (next !== task.status) {
      task.status = next;
      task.version += 1;
      task.updatedAt = nowIso();
      changed.push(task);
    }
  }
  return changed;
}

/** Marks an objective complete once none of its tasks can still make progress. */
export function refreshObjectiveStatus(board: BoardState, objectiveId: string): void {
  const objective = board.objectives.find((item) => item.id === objectiveId);
  if (!objective || objective.status === 'draft' || objective.status === 'planning') {
    return;
  }
  const tasks = board.tasks.filter((task) => task.objectiveId === objectiveId);
  if (tasks.length === 0) {
    return;
  }
  const settled = tasks.every((task) => ['done', 'cancelled', 'failed'].includes(task.status));
  const anyFailed = tasks.some((task) => task.status === 'failed');
  const next: Objective['status'] = settled ? (anyFailed ? 'failed' : 'complete') : 'active';
  if (next !== objective.status) {
    objective.status = next;
    objective.updatedAt = nowIso();
  }
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

export function findTask(board: BoardState, taskId: string): Task {
  const task = board.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new LifecycleError('not_found', 'No task with id "' + taskId + '".');
  }
  return task;
}

/**
 * Atomically claims a task for an agent.
 *
 * `expectedVersion` is the version the caller read before deciding to claim. If
 * anything changed in between - another agent claimed it, a human reprioritised
 * it - the compare fails and the claim is refused rather than silently applied.
 */
export function claimTask(
  board: BoardState,
  taskId: string,
  actor: Actor,
  expectedVersion: number,
  reasoning: string,
  now: Date = new Date()
): Task {
  const task = findTask(board, taskId);

  if (task.version !== expectedVersion) {
    throw new LifecycleError(
      'version_conflict',
      'Task "' +
        taskId +
        '" changed while ' +
        actor.name +
        ' was deciding (expected v' +
        expectedVersion +
        ', found v' +
        task.version +
        ').'
    );
  }

  const verdict = claimability(task, actor.id, board.tasks, now);
  if (!verdict.ok) {
    throw new LifecycleError('not_claimable', 'Cannot claim "' + taskId + '": ' + verdict.reason);
  }

  assertTransition(task.status, 'claimed');

  const before = { status: task.status, lease: task.lease, version: task.version };
  task.status = 'claimed';
  task.lease = {
    agentId: actor.id,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
  };
  task.attempts += 1;
  task.version += 1;
  task.updatedAt = nowIso();

  const agent = board.agents.find((candidate) => candidate.id === actor.id);
  if (agent) {
    agent.currentTaskId = task.id;
    agent.status = 'working';
    agent.activity = 'Claimed "' + task.title + '"';
    agent.lastSeenAt = nowIso();
  }

  appendAudit(board, {
    action: 'task.claimed',
    actor,
    taskId: task.id,
    objectiveId: task.objectiveId,
    summary: actor.name + ' claimed "' + task.title + '".',
    reasoning,
    before,
    after: { status: task.status, lease: task.lease, version: task.version },
  });

  return task;
}

/** Extends the lease on a task the agent already holds, for long-running work. */
export function renewLease(
  board: BoardState,
  taskId: string,
  actor: Actor,
  now: Date = new Date()
): Task {
  const task = findTask(board, taskId);
  if (task.lease?.agentId !== actor.id) {
    throw new LifecycleError('not_holder', actor.name + ' does not hold "' + taskId + '".');
  }
  task.lease = {
    ...task.lease,
    expiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
  };
  task.updatedAt = nowIso();
  return task;
}

/**
 * Moves a held task to a new status. Only the lease holder (or a human) may do
 * this, which is the second half of the mutual-exclusion guarantee: claiming
 * gets you the item, and holding the lease is what lets you act on it.
 *
 * `force` is the operator's override. The transition graph exists to constrain
 * *agents* - it is what stops one finishing an item it never claimed - but the
 * person running the board outranks it, so a human drag may land anywhere
 * except `claimed`, which is meaningless without a lease to go with it.
 */
export function transitionTask(
  board: BoardState,
  taskId: string,
  actor: Actor,
  to: TaskStatus,
  reasoning: string,
  options: { result?: Task['result']; force?: boolean } = {}
): Task {
  const task = findTask(board, taskId);
  const holder = task.lease?.agentId ?? null;
  const isHuman = actor.role === 'human';

  if (!options.force && !isHuman && holder && holder !== actor.id) {
    throw new LifecycleError(
      'not_holder',
      actor.name + ' cannot move "' + taskId + '" because ' + holder + ' holds the lease.'
    );
  }
  if (!options.force && !isHuman && !holder) {
    throw new LifecycleError(
      'not_holder',
      actor.name + ' must claim "' + taskId + '" before moving it to "' + to + '".'
    );
  }

  if (options.force) {
    if (to === 'claimed') {
      throw new LifecycleError(
        'illegal_transition',
        'A task cannot be moved into "claimed" directly; an agent must claim it.'
      );
    }
  } else {
    assertTransition(task.status, to);
  }

  const before = { status: task.status, lease: task.lease, version: task.version };
  task.status = to;
  task.version += 1;
  task.updatedAt = nowIso();

  if (options.result) {
    task.result = options.result;
  }

  // Reaching a resting state releases the claim so the item is free again.
  // `review` counts: it is waiting on a person, so an agent must not sit on it
  // holding a lease that would only be reaped a minute later.
  const releases: TaskStatus[] = [
    'done',
    'failed',
    'cancelled',
    'ready',
    'planned',
    'blocked',
    'review',
  ];
  if (releases.includes(to)) {
    task.lease = null;
    const agent = board.agents.find((candidate) => candidate.id === holder);
    if (agent && agent.currentTaskId === task.id) {
      agent.currentTaskId = null;
      agent.status = 'idle';
      agent.activity =
        to === 'done' ? 'Completed "' + task.title + '"' : 'Released "' + task.title + '"';
      agent.lastSeenAt = nowIso();
      if (to === 'done') {
        agent.tasksCompleted += 1;
      }
    }
  }

  const action: AuditAction =
    to === 'done' ? 'task.completed' : to === 'failed' ? 'task.failed' : 'task.transition';

  appendAudit(board, {
    action,
    actor,
    taskId: task.id,
    objectiveId: task.objectiveId,
    summary:
      actor.name + ' moved "' + task.title + '" from ' + before.status + ' to ' + to + '.',
    reasoning,
    before,
    after: { status: task.status, result: task.result, version: task.version },
  });

  recomputeReadiness(board);
  refreshObjectiveStatus(board, task.objectiveId);

  return task;
}

/** Explicitly gives up a claim without finishing the work. */
export function releaseTask(
  board: BoardState,
  taskId: string,
  actor: Actor,
  reasoning: string
): Task {
  const task = findTask(board, taskId);
  if (task.lease && task.lease.agentId !== actor.id && actor.role !== 'human') {
    throw new LifecycleError('not_holder', actor.name + ' does not hold "' + taskId + '".');
  }
  const before = { status: task.status, lease: task.lease };
  task.lease = null;
  task.status = 'ready';
  task.version += 1;
  task.updatedAt = nowIso();

  const agent = board.agents.find((candidate) => candidate.id === before.lease?.agentId);
  if (agent && agent.currentTaskId === task.id) {
    agent.currentTaskId = null;
    agent.status = 'idle';
    agent.activity = 'Released "' + task.title + '"';
  }

  appendAudit(board, {
    action: 'task.released',
    actor,
    taskId: task.id,
    objectiveId: task.objectiveId,
    summary: actor.name + ' released "' + task.title + '".',
    reasoning,
    before,
    after: { status: task.status, lease: null },
  });

  recomputeReadiness(board);
  return task;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function upsertAgent(board: BoardState, agent: Agent): Agent {
  const existing = board.agents.find((candidate) => candidate.id === agent.id);
  if (existing) {
    Object.assign(existing, agent, { tasksCompleted: existing.tasksCompleted });
    existing.lastSeenAt = nowIso();
    return existing;
  }
  board.agents.push(agent);
  appendAudit(board, {
    action: 'agent.registered',
    actor: { id: agent.id, name: agent.name, role: agent.role },
    summary: agent.name + ' joined the board as a ' + agent.role + '.',
    reasoning: 'Agent pool sized to the run configuration.',
    after: { id: agent.id, role: agent.role },
  });
  return agent;
}

export function setAgentActivity(
  board: BoardState,
  agentId: string,
  status: Agent['status'],
  activity: string | null
): void {
  const agent = board.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return;
  }
  agent.status = status;
  agent.activity = activity;
  agent.lastSeenAt = nowIso();
}

/** The tasks belonging to one objective, in the order agents will pull them. */
export function queueSnapshotFor(board: BoardState, objectiveId: string): Task[] {
  return board.tasks.filter((task) => task.objectiveId === objectiveId);
}

// ---------------------------------------------------------------------------
// Task creation
// ---------------------------------------------------------------------------

export type NewTaskInput = {
  objectiveId: string;
  title: string;
  details: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  priority?: TaskPriority;
  rank?: number;
};

export function createTask(
  board: BoardState,
  actor: Actor,
  input: NewTaskInput,
  reasoning: string
): Task {
  const task: Task = {
    id: newId('task'),
    objectiveId: input.objectiveId,
    title: input.title,
    details: input.details,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    status: 'planned',
    priority: input.priority ?? 3,
    rank: input.rank ?? board.tasks.length,
    dependsOn: input.dependsOn ?? [],
    lease: null,
    assignedAgentId: null,
    pinnedByHuman: false,
    attempts: 0,
    result: null,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  board.tasks.push(task);
  appendAudit(board, {
    action: 'task.created',
    actor,
    taskId: task.id,
    objectiveId: task.objectiveId,
    summary: actor.name + ' created "' + task.title + '".',
    reasoning,
    after: { title: task.title, dependsOn: task.dependsOn, priority: task.priority },
  });
  return task;
}
