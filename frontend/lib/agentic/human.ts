/**
 * Operator controls.
 *
 * A person can change the board at any point, including while agents are
 * running. Every operation here bumps the task `version`, which is precisely
 * what makes an in-flight agent decision based on the old state lose its
 * compare-and-swap and re-decide against what the operator just did. That is how
 * the agents continue from the updated state rather than from their original
 * plan.
 */
import { LifecycleError } from '@/lib/agentic/lifecycle';
import { nowIso } from '@/lib/agentic/ids';
import {
  appendAudit,
  createTask,
  findTask,
  queueSnapshotFor,
  recomputeReadiness,
  refreshObjectiveStatus,
  releaseTask,
  transitionTask,
  withBoard,
} from '@/lib/agentic/store';
import { HUMAN_ACTOR, type Task, type TaskPriority, type TaskStatus } from '@/lib/agentic/types';

/** Changes an item's queue priority. Takes effect on the next agent pull. */
export async function reprioritiseTask(
  taskId: string,
  priority: TaskPriority,
  reasoning: string
): Promise<Task> {
  return withBoard((board) => {
    const task = findTask(board, taskId);
    const before = { priority: task.priority, rank: task.rank };

    task.priority = priority;
    task.pinnedByHuman = true;
    task.version += 1;
    task.updatedAt = nowIso();

    appendAudit(board, {
      action: 'task.reprioritised',
      actor: HUMAN_ACTOR,
      taskId: task.id,
      objectiveId: task.objectiveId,
      summary:
        'Priority of "' + task.title + '" changed from P' + before.priority + ' to P' + priority + '.',
      reasoning,
      before,
      after: { priority: task.priority, rank: task.rank },
    });

    return structuredClone(task);
  });
}

/**
 * Reorders the queue wholesale. Ranks are rewritten to match the given order,
 * so a drag in the UI maps directly onto what the next agent picks up.
 */
export async function reorderQueue(orderedTaskIds: string[], reasoning: string): Promise<Task[]> {
  return withBoard((board) => {
    const changed: Task[] = [];
    orderedTaskIds.forEach((taskId, index) => {
      const task = board.tasks.find((item) => item.id === taskId);
      if (!task || task.rank === index) {
        return;
      }
      const before = { rank: task.rank };
      task.rank = index;
      task.pinnedByHuman = true;
      task.version += 1;
      task.updatedAt = nowIso();
      changed.push(task);

      appendAudit(board, {
        action: 'task.reprioritised',
        actor: HUMAN_ACTOR,
        taskId: task.id,
        objectiveId: task.objectiveId,
        summary: 'Moved "' + task.title + '" to position ' + (index + 1) + ' in the queue.',
        reasoning,
        before,
        after: { rank: task.rank },
      });
    });
    return changed.map((task) => structuredClone(task));
  });
}

/**
 * Pins an item to a specific agent, or unpins it back to the open queue.
 *
 * If another agent currently holds the item, its claim is released first so the
 * reassignment actually takes effect rather than waiting for a lease to lapse.
 */
export async function reassignTask(
  taskId: string,
  agentId: string | null,
  reasoning: string
): Promise<Task> {
  return withBoard((board) => {
    const task = findTask(board, taskId);
    if (agentId && !board.agents.some((agent) => agent.id === agentId)) {
      throw new LifecycleError('not_found', 'No agent with id "' + agentId + '".');
    }

    const before = { assignedAgentId: task.assignedAgentId, lease: task.lease };
    const holder = task.lease?.agentId ?? null;

    if (holder && holder !== agentId) {
      releaseTask(
        board,
        task.id,
        HUMAN_ACTOR,
        'Released from ' + holder + ' so the operator could reassign the item.'
      );
    }

    task.assignedAgentId = agentId;
    task.pinnedByHuman = true;
    task.version += 1;
    task.updatedAt = nowIso();

    appendAudit(board, {
      action: 'task.reassigned',
      actor: HUMAN_ACTOR,
      taskId: task.id,
      objectiveId: task.objectiveId,
      summary: agentId
        ? 'Reserved "' + task.title + '" for ' + agentId + '.'
        : 'Returned "' + task.title + '" to the open queue.',
      reasoning,
      before,
      after: { assignedAgentId: task.assignedAgentId },
    });

    recomputeReadiness(board);
    return structuredClone(task);
  });
}

/**
 * Moves an item to a status directly - what a drag between columns does.
 * Uses `force` because the operator outranks whichever agent holds the lease.
 */
export async function moveTask(taskId: string, to: TaskStatus, reasoning: string): Promise<Task> {
  return withBoard((board) => {
    const task = transitionTask(board, taskId, HUMAN_ACTOR, to, reasoning, { force: true });
    task.pinnedByHuman = true;
    return structuredClone(task);
  });
}

/** Edits the text of an item. Agents pick the new wording up on their next pull. */
export async function editTask(
  taskId: string,
  patch: { title?: string; details?: string; acceptanceCriteria?: string[] },
  reasoning: string
): Promise<Task> {
  return withBoard((board) => {
    const task = findTask(board, taskId);
    const before = {
      title: task.title,
      details: task.details,
      acceptanceCriteria: task.acceptanceCriteria,
    };

    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (!trimmed) {
        throw new LifecycleError('invalid', 'A task needs a title.');
      }
      task.title = trimmed;
    }
    if (patch.details !== undefined) {
      task.details = patch.details.trim();
    }
    if (patch.acceptanceCriteria !== undefined) {
      task.acceptanceCriteria = patch.acceptanceCriteria.filter((item) => item.trim());
    }

    task.pinnedByHuman = true;
    task.version += 1;
    task.updatedAt = nowIso();

    appendAudit(board, {
      action: 'task.edited',
      actor: HUMAN_ACTOR,
      taskId: task.id,
      objectiveId: task.objectiveId,
      summary: 'Edited "' + task.title + '".',
      reasoning,
      before,
      after: {
        title: task.title,
        details: task.details,
        acceptanceCriteria: task.acceptanceCriteria,
      },
    });

    return structuredClone(task);
  });
}

/** Changes an item's dependencies. Readiness is recomputed straight away. */
export async function setDependencies(
  taskId: string,
  dependsOn: string[],
  reasoning: string
): Promise<Task> {
  return withBoard((board) => {
    const task = findTask(board, taskId);
    const known = new Set(board.tasks.map((item) => item.id));
    const before = { dependsOn: task.dependsOn };

    task.dependsOn = [...new Set(dependsOn)].filter((id) => known.has(id) && id !== task.id);
    task.pinnedByHuman = true;
    task.version += 1;
    task.updatedAt = nowIso();

    appendAudit(board, {
      action: 'task.edited',
      actor: HUMAN_ACTOR,
      taskId: task.id,
      objectiveId: task.objectiveId,
      summary: 'Set ' + task.dependsOn.length + ' dependency(ies) on "' + task.title + '".',
      reasoning,
      before,
      after: { dependsOn: task.dependsOn },
    });

    recomputeReadiness(board);
    refreshObjectiveStatus(board, task.objectiveId);
    return structuredClone(task);
  });
}

/** Adds a work item by hand, alongside whatever the planner produced. */
export async function addManualTask(
  objectiveId: string,
  input: { title: string; details: string; priority?: TaskPriority },
  reasoning: string
): Promise<Task> {
  return withBoard((board) => {
    if (!board.objectives.some((objective) => objective.id === objectiveId)) {
      throw new LifecycleError('not_found', 'No objective with id "' + objectiveId + '".');
    }
    const task = createTask(
      board,
      HUMAN_ACTOR,
      {
        objectiveId,
        title: input.title,
        details: input.details,
        priority: input.priority ?? 2,
        rank: queueSnapshotFor(board, objectiveId).length,
      },
      reasoning
    );
    task.pinnedByHuman = true;
    recomputeReadiness(board);
    return structuredClone(task);
  });
}

/** Deletes an item and detaches it from anything that depended on it. */
export async function deleteTask(taskId: string, reasoning: string): Promise<void> {
  await withBoard((board) => {
    const task = findTask(board, taskId);
    board.tasks = board.tasks.filter((item) => item.id !== taskId);
    board.tasks.forEach((other) => {
      if (other.dependsOn.includes(taskId)) {
        other.dependsOn = other.dependsOn.filter((id) => id !== taskId);
        other.version += 1;
      }
    });

    appendAudit(board, {
      action: 'task.edited',
      actor: HUMAN_ACTOR,
      taskId,
      objectiveId: task.objectiveId,
      summary: 'Deleted "' + task.title + '".',
      reasoning,
      before: { title: task.title, status: task.status },
      after: null,
    });

    recomputeReadiness(board);
    refreshObjectiveStatus(board, task.objectiveId);
  });
}
