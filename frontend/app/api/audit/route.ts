import { NextResponse } from 'next/server';
import { errorResponse } from '@/app/api/_lib/respond';
import { readBoard } from '@/lib/agentic/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The audit trail, newest first, optionally narrowed to one task so a reviewer
 * can read the full history of a single item.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const taskId = url.searchParams.get('taskId');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));

    const board = await readBoard();
    const events = board.audit
      .filter((event) => !taskId || event.taskId === taskId)
      .slice(-limit)
      .reverse();

    return NextResponse.json({ events, total: board.audit.length });
  } catch (error) {
    return errorResponse(error);
  }
}
