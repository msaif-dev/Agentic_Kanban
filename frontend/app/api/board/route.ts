import { NextResponse } from 'next/server';
import { errorResponse } from '@/app/api/_lib/respond';
import { getOrchestrator } from '@/lib/agentic/orchestrator';
import { readBoard, reapExpiredLeases, recomputeReadiness, withBoard } from '@/lib/agentic/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The board snapshot the UI polls.
 *
 * Reading also runs housekeeping, so an operator watching a stopped board still
 * sees expired leases reclaimed and readiness kept honest.
 */
export async function GET() {
  try {
    await withBoard((board) => {
      reapExpiredLeases(board);
      recomputeReadiness(board);
      board.run.running = getOrchestrator().isRunning();
    });
    const board = await readBoard();
    return NextResponse.json(board);
  } catch (error) {
    return errorResponse(error);
  }
}
