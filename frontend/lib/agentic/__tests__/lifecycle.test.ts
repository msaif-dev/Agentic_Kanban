// @vitest-environment node
// These exercise server-side modules; jsdom would make the SDK refuse to load.
import { describe, expect, it } from 'vitest';
import {
  breakCycles,
  canTransition,
  claimability,
  dependenciesSatisfied,
  derivedStatus,
  findCycles,
  isLeaseExpired,
  queueOrder,
  selectNextTask,
  unmetDependencies,
} from '@/lib/agentic/lifecycle';
import { makeTask } from '@/lib/agentic/__tests__/harness';

describe('transition rules', () => {
  it('permits the normal path through the lifecycle', () => {
    expect(canTransition('planned', 'ready')).toBe(true);
    expect(canTransition('ready', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'review')).toBe(true);
    expect(canTransition('review', 'done')).toBe(true);
  });

  it('refuses to skip the claim step', () => {
    expect(canTransition('ready', 'in_progress')).toBe(false);
    expect(canTransition('ready', 'done')).toBe(false);
    expect(canTransition('planned', 'done')).toBe(false);
  });

  it('treats cancelled and done as resting states, not dead ends', () => {
    expect(canTransition('done', 'ready')).toBe(true);
    expect(canTransition('cancelled', 'planned')).toBe(true);
    expect(canTransition('done', 'in_progress')).toBe(false);
  });
});

describe('dependency handling', () => {
  const finished = makeTask({ id: 'a', status: 'done' });
  const pending = makeTask({ id: 'b', status: 'in_progress' });

  it('only counts a dependency as met when it is done', () => {
    const dependent = makeTask({ id: 'c', dependsOn: ['a'] });
    expect(dependenciesSatisfied(dependent, [finished, pending, dependent])).toBe(true);

    const blocked = makeTask({ id: 'd', dependsOn: ['a', 'b'] });
    expect(dependenciesSatisfied(blocked, [finished, pending, blocked])).toBe(false);
    expect(unmetDependencies(blocked, [finished, pending, blocked]).map((t) => t.id)).toEqual(['b']);
  });

  it('ignores dependencies on tasks that no longer exist', () => {
    const orphan = makeTask({ id: 'e', dependsOn: ['deleted'] });
    expect(dependenciesSatisfied(orphan, [orphan])).toBe(true);
  });

  it('derives blocked and ready from the dependency graph', () => {
    const blocked = makeTask({ id: 'f', status: 'ready', dependsOn: ['b'] });
    expect(derivedStatus(blocked, [pending, blocked])).toBe('blocked');

    const unblocked = makeTask({ id: 'g', status: 'blocked', dependsOn: ['a'] });
    expect(derivedStatus(unblocked, [finished, unblocked])).toBe('ready');
  });

  it('never re-derives a task an agent currently holds', () => {
    const held = makeTask({ id: 'h', status: 'in_progress', dependsOn: ['b'] });
    expect(derivedStatus(held, [pending, held])).toBe('in_progress');
  });
});

describe('claim eligibility', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');

  it('lets an idle agent take a ready, unheld task', () => {
    const task = makeTask();
    expect(claimability(task, 'worker-1', [task], now).ok).toBe(true);
  });

  it('refuses a task another agent already holds', () => {
    const task = makeTask({
      status: 'claimed',
      lease: {
        agentId: 'worker-1',
        claimedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    });
    const verdict = claimability(task, 'worker-2', [task], now);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('worker-1');
  });

  it('offers the task again once the lease has lapsed', () => {
    const task = makeTask({
      status: 'ready',
      lease: {
        agentId: 'worker-1',
        claimedAt: new Date(now.getTime() - 120_000).toISOString(),
        expiresAt: new Date(now.getTime() - 60_000).toISOString(),
      },
    });
    expect(isLeaseExpired(task, now)).toBe(true);
    expect(claimability(task, 'worker-2', [task], now).ok).toBe(true);
  });

  it('honours a human reservation', () => {
    const task = makeTask({ assignedAgentId: 'worker-2' });
    expect(claimability(task, 'worker-1', [task], now).ok).toBe(false);
    expect(claimability(task, 'worker-2', [task], now).ok).toBe(true);
  });

  it('refuses a task whose dependencies are unmet', () => {
    const upstream = makeTask({ id: 'up', status: 'ready' });
    const task = makeTask({ id: 'down', dependsOn: ['up'] });
    expect(claimability(task, 'worker-1', [upstream, task], now).ok).toBe(false);
  });
});

describe('queue ordering', () => {
  it('sorts by priority, then plan rank, then age', () => {
    const urgent = makeTask({ id: 'a', priority: 1, rank: 9 });
    const normal = makeTask({ id: 'b', priority: 3, rank: 0 });
    const later = makeTask({ id: 'c', priority: 3, rank: 1 });

    expect([later, normal, urgent].sort(queueOrder).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('gives an agent its own reserved task ahead of the general queue', () => {
    const urgentOpen = makeTask({ id: 'open', priority: 1 });
    const reserved = makeTask({ id: 'mine', priority: 5, assignedAgentId: 'worker-2' });

    expect(selectNextTask([urgentOpen, reserved], 'worker-2')?.id).toBe('mine');
    expect(selectNextTask([urgentOpen, reserved], 'worker-1')?.id).toBe('open');
  });

  it('returns null when nothing is claimable', () => {
    const blocked = makeTask({ id: 'a', status: 'blocked' });
    expect(selectNextTask([blocked], 'worker-1')).toBeNull();
  });
});

describe('cycle safety', () => {
  it('finds a dependency cycle', () => {
    const a = makeTask({ id: 'a', dependsOn: ['b'] });
    const b = makeTask({ id: 'b', dependsOn: ['a'] });
    expect(findCycles([a, b]).sort()).toEqual(['a', 'b']);
  });

  it('leaves an acyclic graph untouched', () => {
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b', dependsOn: ['a'] });
    expect(findCycles([a, b])).toEqual([]);
    expect(breakCycles([a, b])).toEqual([a, b]);
  });

  it('breaks a cycle so the work can still run', () => {
    const a = makeTask({ id: 'a', dependsOn: ['b'] });
    const b = makeTask({ id: 'b', dependsOn: ['a'] });
    const repaired = breakCycles([a, b]);
    expect(findCycles(repaired)).toEqual([]);
  });
});
