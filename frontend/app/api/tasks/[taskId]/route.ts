import { NextResponse } from 'next/server';
import { errorResponse, readJson, requireString } from '@/app/api/_lib/respond';
import { LifecycleError } from '@/lib/agentic/lifecycle';
import {
  deleteTask,
  editTask,
  moveTask,
  reassignTask,
  reprioritiseTask,
  setDependencies,
} from '@/lib/agentic/human';
import { TASK_STATUSES, type TaskPriority, type TaskStatus } from '@/lib/agentic/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { taskId: string } };

type PatchBody = {
  op?: 'move' | 'reprioritise' | 'reassign' | 'edit' | 'dependencies';
  reasoning?: string;
  status?: string;
  priority?: number;
  agentId?: string | null;
  title?: string;
  details?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
};

/**
 * Operator edits to a single work item.
 *
 * Each operation records the operator's stated reasoning on the audit trail
 * alongside the agents' own entries, so the history reads as one story.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const body = await readJson<PatchBody>(request);
    const reasoning = (body.reasoning ?? '').trim() || 'Operator changed the board directly.';

    switch (body.op) {
      case 'move': {
        const status = requireString(body.status, 'status') as TaskStatus;
        if (!TASK_STATUSES.includes(status)) {
          throw new LifecycleError('invalid', status + ' is not a valid status.');
        }
        return NextResponse.json({ task: await moveTask(params.taskId, status, reasoning) });
      }
      case 'reprioritise': {
        const priority = Number(body.priority);
        if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
          throw new LifecycleError('invalid', 'priority must be an integer from 1 to 5.');
        }
        return NextResponse.json({
          task: await reprioritiseTask(params.taskId, priority as TaskPriority, reasoning),
        });
      }
      case 'reassign': {
        const agentId = body.agentId ? String(body.agentId) : null;
        return NextResponse.json({ task: await reassignTask(params.taskId, agentId, reasoning) });
      }
      case 'edit':
        return NextResponse.json({
          task: await editTask(
            params.taskId,
            {
              title: body.title,
              details: body.details,
              acceptanceCriteria: body.acceptanceCriteria,
            },
            reasoning
          ),
        });
      case 'dependencies':
        return NextResponse.json({
          task: await setDependencies(params.taskId, body.dependsOn ?? [], reasoning),
        });
      default:
        throw new LifecycleError(
          'invalid',
          'op must be one of move, reprioritise, reassign, edit, dependencies.'
        );
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    await deleteTask(params.taskId, 'Operator removed the item from the board.');
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
