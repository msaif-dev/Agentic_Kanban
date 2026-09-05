import { NextResponse } from 'next/server';
import { errorResponse, readJson, requireString } from '@/app/api/_lib/respond';
import { addManualTask, reorderQueue } from '@/lib/agentic/human';
import { readBoard } from '@/lib/agentic/store';
import type { TaskPriority } from '@/lib/agentic/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const board = await readBoard();
    return NextResponse.json({ tasks: board.tasks });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Adds a work item by hand alongside the planner's output. */
export async function POST(request: Request) {
  try {
    const body = await readJson<{
      objectiveId?: unknown;
      title?: unknown;
      details?: unknown;
      priority?: number;
    }>(request);

    const task = await addManualTask(
      requireString(body.objectiveId, 'objectiveId'),
      {
        title: requireString(body.title, 'title'),
        details: typeof body.details === 'string' ? body.details : '',
        priority: (body.priority as TaskPriority) ?? 2,
      },
      'Operator added this item to the objective by hand.'
    );
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Rewrites queue order, which is what a drag-to-reorder in the UI sends. */
export async function PUT(request: Request) {
  try {
    const body = await readJson<{ orderedTaskIds?: unknown; reasoning?: string }>(request);
    const ids = Array.isArray(body.orderedTaskIds) ? body.orderedTaskIds.map(String) : [];
    const changed = await reorderQueue(
      ids,
      (body.reasoning ?? '').trim() || 'Operator reordered the queue.'
    );
    return NextResponse.json({ tasks: changed });
  } catch (error) {
    return errorResponse(error);
  }
}
