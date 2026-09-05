/**
 * Typed client for the board API.
 *
 * Every call surfaces the server's error message rather than a generic failure,
 * because the interesting errors here are meaningful to the operator: a claim
 * race, a stale version, an illegal move.
 */
import type { BoardState, Objective, Task, TaskPriority, TaskStatus } from '@/lib/agentic/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : 'Request failed with status ' + response.status + '.';
    throw new Error(message);
  }
  return payload as T;
}

export function fetchBoard(): Promise<BoardState> {
  return request<BoardState>('/api/board');
}

export function submitObjective(goal: string): Promise<{ objective: Objective; tasks: Task[] }> {
  return request('/api/objectives', { method: 'POST', body: JSON.stringify({ goal }) });
}

export function controlRun(
  action: 'start' | 'stop' | 'step',
  workerCount?: number
): Promise<{ run: BoardState['run'] }> {
  return request('/api/run', { method: 'POST', body: JSON.stringify({ action, workerCount }) });
}

export function moveTask(taskId: string, status: TaskStatus, reasoning: string): Promise<{ task: Task }> {
  return request('/api/tasks/' + taskId, {
    method: 'PATCH',
    body: JSON.stringify({ op: 'move', status, reasoning }),
  });
}

export function reprioritiseTask(
  taskId: string,
  priority: TaskPriority,
  reasoning: string
): Promise<{ task: Task }> {
  return request('/api/tasks/' + taskId, {
    method: 'PATCH',
    body: JSON.stringify({ op: 'reprioritise', priority, reasoning }),
  });
}

export function reassignTask(
  taskId: string,
  agentId: string | null,
  reasoning: string
): Promise<{ task: Task }> {
  return request('/api/tasks/' + taskId, {
    method: 'PATCH',
    body: JSON.stringify({ op: 'reassign', agentId, reasoning }),
  });
}

export function editTask(
  taskId: string,
  patch: { title?: string; details?: string },
  reasoning: string
): Promise<{ task: Task }> {
  return request('/api/tasks/' + taskId, {
    method: 'PATCH',
    body: JSON.stringify({ op: 'edit', ...patch, reasoning }),
  });
}

export function deleteTask(taskId: string): Promise<{ ok: true }> {
  return request('/api/tasks/' + taskId, { method: 'DELETE' });
}

export function addTask(
  objectiveId: string,
  title: string,
  details: string,
  priority: TaskPriority
): Promise<{ task: Task }> {
  return request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objectiveId, title, details, priority }),
  });
}

export function reorderQueue(orderedTaskIds: string[], reasoning: string): Promise<{ tasks: Task[] }> {
  return request('/api/tasks', {
    method: 'PUT',
    body: JSON.stringify({ orderedTaskIds, reasoning }),
  });
}
