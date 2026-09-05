import { randomUUID } from 'node:crypto';

/** Short, readable, collision-resistant id with a type prefix. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
