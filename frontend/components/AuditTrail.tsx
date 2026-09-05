"use client";

import { useMemo, useState } from 'react';
import { formatTime } from '@/lib/board';
import type { AuditEvent, BoardState } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

type AuditTrailProps = {
  board: BoardState;
  /** When set, the trail narrows to one item's history. */
  focusTaskId: string | null;
  onClearFocus: () => void;
};

/**
 * The audit trail.
 *
 * Every entry names the actor, the change, and the reasoning behind it, so a
 * reviewer can reconstruct why the board looks the way it does - including
 * which decisions were an agent's and which were the operator's.
 */
export function AuditTrail({ board, focusTaskId, onClearFocus }: AuditTrailProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const events = useMemo(() => {
    const filtered = focusTaskId
      ? board.audit.filter((event) => event.taskId === focusTaskId)
      : board.audit;
    return filtered.slice(-80).reverse();
  }, [board.audit, focusTaskId]);

  const focusTitle = focusTaskId
    ? board.tasks.find((task) => task.id === focusTaskId)?.title ?? 'this item'
    : null;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Audit trail</h2>
        {focusTaskId ? (
          <button type="button" className={styles.linkButton} onClick={onClearFocus}>
            Show all
          </button>
        ) : (
          <span className={styles.panelCount}>{board.audit.length} events</span>
        )}
      </div>

      {focusTitle ? <p className={styles.panelNote}>History of &ldquo;{focusTitle}&rdquo;</p> : null}

      {events.length === 0 ? (
        <p className={styles.panelEmpty}>Nothing recorded yet.</p>
      ) : (
        <ol className={styles.auditList} data-testid="audit-list">
          {events.map((event) => (
            <AuditRow
              key={event.id}
              event={event}
              isOpen={expanded === event.id}
              onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function AuditRow({
  event,
  isOpen,
  onToggle,
}: {
  event: AuditEvent;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const hasDiff = Boolean(event.before || event.after);

  return (
    <li className={styles.auditRow} data-action={event.action}>
      <div className={styles.auditHead}>
        <span className={styles.auditActor} data-role={event.actorRole}>
          {event.actorName}
        </span>
        <span className={styles.auditTime}>{formatTime(event.at)}</span>
      </div>

      <p className={styles.auditSummary}>{event.summary}</p>
      <p className={styles.auditReasoning}>{event.reasoning}</p>

      {hasDiff ? (
        <>
          <button type="button" className={styles.linkButton} onClick={onToggle}>
            {isOpen ? 'Hide change' : 'Show change'}
          </button>
          {isOpen ? (
            <pre className={styles.auditDiff}>
              {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
            </pre>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
