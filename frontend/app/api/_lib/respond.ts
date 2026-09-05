import { NextResponse } from 'next/server';
import { LifecycleError } from '@/lib/agentic/lifecycle';

/** Every board route runs on Node: the store touches the filesystem. */
export const nodeRuntime = 'nodejs';

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  version_conflict: 409,
  not_claimable: 409,
  not_holder: 409,
  illegal_transition: 422,
  invalid: 400,
};

/**
 * Maps a thrown error onto a response. Lifecycle violations are expected
 * outcomes of a contended board, not server faults, so they get precise codes.
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof LifecycleError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: STATUS_BY_CODE[error.code] ?? 400 }
    );
  }
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  return NextResponse.json({ error: message, code: 'internal' }, { status: 500 });
}

/** Reads and validates a JSON body, giving a clear error when it is malformed. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new LifecycleError('invalid', 'Request body must be valid JSON.');
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LifecycleError('invalid', field + ' is required.');
  }
  return value.trim();
}
