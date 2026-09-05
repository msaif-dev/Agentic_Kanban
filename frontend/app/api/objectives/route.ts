import { NextResponse } from 'next/server';
import { errorResponse, readJson, requireString } from '@/app/api/_lib/respond';
import { createAndPlan } from '@/lib/agentic/planner';
import { readBoard } from '@/lib/agentic/store';
import { HUMAN_ACTOR } from '@/lib/agentic/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const board = await readBoard();
    return NextResponse.json({ objectives: board.objectives });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Submits a high-level objective and runs the planning pass on it, returning
 * the ordered work items the planner produced.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<{ goal?: unknown }>(request);
    const goal = requireString(body.goal, 'goal');
    const { objective, tasks } = await createAndPlan(goal, HUMAN_ACTOR);
    return NextResponse.json({ objective, tasks }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
