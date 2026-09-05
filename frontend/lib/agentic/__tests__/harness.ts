import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

/**
 * Loads a fresh copy of the agentic modules against an isolated data directory.
 *
 * The store reads its directory once at module load, so each test needs its own
 * module registry as well as its own temp folder. `vi.resetModules()` gives us
 * both and keeps tests independent of one another's board files.
 */
export async function freshBoard() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-board-'));
  process.env.AGENTIC_DATA_DIR = dir;
  vi.resetModules();

  // The orchestrator and the store cache are parked on globalThis so all of
  // Next.js's per-route bundles share them. Resetting the module registry alone
  // would therefore leave the previous test's board and agents in place.
  const shared = globalThis as { __agenticOrchestrator?: unknown; __agenticStore?: unknown };
  delete shared.__agenticOrchestrator;
  delete shared.__agenticStore;

  const store = await import('@/lib/agentic/store');
  const lifecycle = await import('@/lib/agentic/lifecycle');
  const planner = await import('@/lib/agentic/planner');
  const orchestrator = await import('@/lib/agentic/orchestrator');
  const human = await import('@/lib/agentic/human');
  const brain = await import('@/lib/agentic/brain');
  const types = await import('@/lib/agentic/types');

  store.resetCache();

  return {
    dir,
    store,
    lifecycle,
    planner,
    orchestrator,
    human,
    brain,
    types,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof freshBoard>>;

/**
 * Reloads the store against a data directory that already exists, which is how
 * the tests simulate a process restart: same board file, brand new module state.
 */
export async function reopenBoard(dir: string) {
  process.env.AGENTIC_DATA_DIR = dir;
  vi.resetModules();
  const shared = globalThis as { __agenticOrchestrator?: unknown; __agenticStore?: unknown };
  delete shared.__agenticOrchestrator;
  delete shared.__agenticStore;
  const store = await import('@/lib/agentic/store');
  store.resetCache();
  return store;
}

/** Builds a task literal without repeating every field in every test. */
export function makeTask(overrides: Partial<import('@/lib/agentic/types').Task> = {}) {
  const base: import('@/lib/agentic/types').Task = {
    id: 'task_1',
    objectiveId: 'obj_1',
    title: 'Test task',
    details: '',
    acceptanceCriteria: [],
    status: 'ready',
    priority: 3,
    rank: 0,
    dependsOn: [],
    lease: null,
    assignedAgentId: null,
    pinnedByHuman: false,
    attempts: 0,
    result: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}
