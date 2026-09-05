/**
 * Core domain types for the autonomous task board.
 *
 * The board is the single shared artefact that planner agents, worker agents and
 * a human operator all act on. Every mutation flows through `lib/agentic/store.ts`
 * so that concurrency rules and the audit trail cannot be bypassed.
 */

/**
 * The explicit lifecycle a work item moves through.
 *
 * A task is only workable from `ready`, and only ever by the agent that holds its
 * claim. `blocked` is derived from unmet dependencies rather than set by hand.
 */
export type TaskStatus =
  | 'planned'
  | 'blocked'
  | 'ready'
  | 'claimed'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

export const TASK_STATUSES: TaskStatus[] = [
  'planned',
  'blocked',
  'ready',
  'claimed',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
];

/** Statuses that mean the item will never be worked again. */
export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'cancelled'];

/** Statuses in which an agent currently holds the item. */
export const HELD_STATUSES: TaskStatus[] = ['claimed', 'in_progress', 'review'];

/**
 * Legal lifecycle transitions. Anything not listed here is rejected by
 * `assertTransition`, which is what stops an agent from, say, marking a task
 * `done` without ever claiming it.
 */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  planned: ['ready', 'blocked', 'cancelled'],
  blocked: ['ready', 'planned', 'cancelled'],
  ready: ['claimed', 'blocked', 'planned', 'cancelled'],
  claimed: ['in_progress', 'ready', 'failed', 'cancelled'],
  in_progress: ['review', 'done', 'failed', 'ready', 'cancelled'],
  review: ['done', 'failed', 'ready', 'in_progress', 'cancelled'],
  failed: ['ready', 'planned', 'cancelled'],
  done: ['ready'],
  cancelled: ['planned', 'ready'],
};

export type AgentRole = 'planner' | 'worker' | 'human';

export type AgentStatus = 'idle' | 'planning' | 'working' | 'stopped' | 'error';

export type Agent = {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  /** Task the agent is currently holding, if any. */
  currentTaskId: string | null;
  /** Short human-readable note about what the agent is doing right now. */
  activity: string | null;
  tasksCompleted: number;
  lastSeenAt: string;
};

/**
 * A lease is what makes claiming safe: an agent holds a task only until
 * `expiresAt`, after which the reaper may return the item to the queue so a
 * crashed or wedged agent cannot strand work forever.
 */
export type Lease = {
  agentId: string;
  claimedAt: string;
  expiresAt: string;
};

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

export type Task = {
  id: string;
  objectiveId: string;
  title: string;
  details: string;
  /** Concrete definition of done, produced by the planning pass. */
  acceptanceCriteria: string[];
  status: TaskStatus;
  /** 1 is most urgent. The human can reorder the queue by changing this. */
  priority: TaskPriority;
  /** Ordering rank inside the queue; lower runs first among equal priorities. */
  rank: number;
  /** Ids of tasks that must reach `done` before this one becomes `ready`. */
  dependsOn: string[];
  lease: Lease | null;
  /** Agent the human has pinned this task to; only that agent may claim it. */
  assignedAgentId: string | null;
  /** Set when a human edits the item, so agents know not to re-plan over it. */
  pinnedByHuman: boolean;
  attempts: number;
  result: TaskResult | null;
  /**
   * Optimistic-concurrency token. Every write bumps it, and claim/transition
   * calls must present the version they read, which is what prevents two agents
   * from acting on the same item.
   */
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskResult = {
  summary: string;
  output: string;
  producedBy: string;
  completedAt: string;
};

export type ObjectiveStatus = 'draft' | 'planning' | 'active' | 'complete' | 'failed';

export type Objective = {
  id: string;
  goal: string;
  status: ObjectiveStatus;
  /** The planner's reasoning for the decomposition it produced. */
  planRationale: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditAction =
  | 'objective.created'
  | 'objective.status'
  | 'plan.started'
  | 'plan.completed'
  | 'plan.failed'
  | 'task.created'
  | 'task.claimed'
  | 'task.released'
  | 'task.transition'
  | 'task.completed'
  | 'task.failed'
  | 'task.reprioritised'
  | 'task.reassigned'
  | 'task.edited'
  | 'task.lease_expired'
  | 'agent.registered'
  | 'agent.status'
  | 'run.started'
  | 'run.stopped';

/**
 * Append-only record of every change to the board. This is what lets a reviewer
 * trace which agent touched an item and why.
 */
export type AuditEvent = {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  actorRole: AgentRole;
  action: AuditAction;
  taskId: string | null;
  objectiveId: string | null;
  summary: string;
  /** The actor's stated reasoning for the change. */
  reasoning: string;
  /** Before/after snapshot of whichever fields the action changed. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type RunState = {
  running: boolean;
  /** How many worker agents the orchestrator keeps in the pool. */
  workerCount: number;
  startedAt: string | null;
  stoppedAt: string | null;
  ticks: number;
  lastError: string | null;
};

/** The whole persisted board. This is what gets written to disk. */
export type BoardState = {
  version: number;
  objectives: Objective[];
  tasks: Task[];
  agents: Agent[];
  audit: AuditEvent[];
  run: RunState;
  updatedAt: string;
};

/** Identifies whoever is making a change, for the audit trail. */
export type Actor = Pick<Agent, 'id' | 'name' | 'role'>;

export const HUMAN_ACTOR: Actor = {
  id: 'human-operator',
  name: 'Human operator',
  role: 'human',
};
