import { NextResponse } from 'next/server';
import { errorResponse, readJson } from '@/app/api/_lib/respond';
import { LifecycleError } from '@/lib/agentic/lifecycle';
import { MAX_WORKERS, MIN_WORKERS, getOrchestrator } from '@/lib/agentic/orchestrator';
import { readBoard } from '@/lib/agentic/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RunAction = 'start' | 'stop' | 'step';

/**
 * Controls the autonomous run.
 *
 * `step` advances exactly one claim-work-release cycle, which keeps the board
 * inspectable: an operator can watch a single agent take a single item.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<{ action?: RunAction; workerCount?: number }>(request);
    const orchestrator = getOrchestrator();

    switch (body.action) {
      case 'start': {
        const requested = Number(body.workerCount ?? 2);
        if (!Number.isFinite(requested)) {
          throw new LifecycleError('invalid', 'workerCount must be a number.');
        }
        const count = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, Math.round(requested)));
        await orchestrator.start(count);
        break;
      }
      case 'stop':
        await orchestrator.stop();
        break;
      case 'step':
        await orchestrator.planPending();
        await orchestrator.step();
        break;
      default:
        throw new LifecycleError('invalid', 'action must be one of start, stop, step.');
    }

    const board = await readBoard();
    return NextResponse.json({ run: { ...board.run, running: orchestrator.isRunning() } });
  } catch (error) {
    return errorResponse(error);
  }
}
