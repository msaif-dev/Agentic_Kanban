/**
 * Board presentation model.
 *
 * The columns are the task lifecycle, so what an operator sees on the board and
 * what the agents enforce internally are the same thing - there is no separate
 * notion of "which column a card is in".
 */
import type { Agent, BoardState, Task, TaskStatus } from '@/lib/agentic/types';

export type ColumnDefinition = {
  id: TaskStatus;
  title: string;
  /** One line explaining what this stage means, shown under the column title. */
  hint: string;
};

/**
 * `planned` is deliberately absent: readiness is derived, so a planned item is
 * shown as either ready or blocked the moment its dependencies are known.
 */
export const BOARD_COLUMNS: ColumnDefinition[] = [
  { id: 'blocked', title: 'Blocked', hint: 'Waiting on upstream results' },
  { id: 'ready', title: 'Ready', hint: 'Unclaimed and workable now' },
  { id: 'claimed', title: 'Claimed', hint: 'An agent holds the lease' },
  { id: 'in_progress', title: 'In Progress', hint: 'Being worked right now' },
  { id: 'review', title: 'Review', hint: 'Waiting for a person' },
  { id: 'done', title: 'Done', hint: 'Finished and released' },
];

/** Columns plus the exception states, which are only shown when occupied. */
export const OVERFLOW_STATUSES: TaskStatus[] = ['failed', 'cancelled', 'planned'];

export type BoardColumnView = ColumnDefinition & { tasks: Task[] };

/** Groups tasks into columns in the order agents would pull them. */
export function toColumns(tasks: Task[], objectiveId: string | null): BoardColumnView[] {
  const scoped = objectiveId ? tasks.filter((task) => task.objectiveId === objectiveId) : tasks;

  const columns: BoardColumnView[] = BOARD_COLUMNS.map((column) => ({
    ...column,
    tasks: scoped.filter((task) => task.status === column.id).sort(compareForDisplay),
  }));

  // Exception states share the first column rather than getting lanes of their
  // own, so the happy path stays legible on a normal screen.
  const overflow = scoped
    .filter((task) => OVERFLOW_STATUSES.includes(task.status))
    .sort(compareForDisplay);
  if (overflow.length > 0) {
    columns[0] = { ...columns[0], tasks: [...overflow, ...columns[0].tasks] };
  }

  return columns;
}

function compareForDisplay(a: Task, b: Task): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

export function agentById(board: BoardState, agentId: string | null): Agent | null {
  if (!agentId) {
    return null;
  }
  return board.agents.find((agent) => agent.id === agentId) ?? null;
}

/** The agent currently holding a task, if any. */
export function holderOf(board: BoardState, task: Task): Agent | null {
  return agentById(board, task.lease?.agentId ?? null);
}

export function taskById(board: BoardState, taskId: string | null): Task | null {
  if (!taskId) {
    return null;
  }
  return board.tasks.find((task) => task.id === taskId) ?? null;
}

/** Titles of the tasks this one is waiting on, for display on the card. */
export function blockedByTitles(board: BoardState, task: Task): string[] {
  return task.dependsOn
    .map((id) => board.tasks.find((candidate) => candidate.id === id))
    .filter((dep): dep is Task => Boolean(dep) && dep!.status !== 'done')
    .map((dep) => dep.title);
}

export type ProgressSummary = {
  total: number;
  done: number;
  active: number;
  blocked: number;
  failed: number;
  percent: number;
};

export function summarise(tasks: Task[]): ProgressSummary {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const active = tasks.filter((task) =>
    ['claimed', 'in_progress', 'review'].includes(task.status)
  ).length;
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  return {
    total,
    done,
    active,
    blocked,
    failed,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Human-readable label for a status, used on badges. */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: 'Planned',
  blocked: 'Blocked',
  ready: 'Ready',
  claimed: 'Claimed',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
