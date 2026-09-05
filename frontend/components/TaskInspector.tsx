"use client";

import { useEffect, useState } from 'react';
import { STATUS_LABELS, agentById, blockedByTitles, formatTime, holderOf } from '@/lib/board';
import type { BoardState, Task, TaskPriority } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

type TaskInspectorProps = {
  board: BoardState;
  task: Task;
  onClose: () => void;
  onReprioritise: (taskId: string, priority: TaskPriority, reasoning: string) => Promise<void>;
  onReassign: (taskId: string, agentId: string | null, reasoning: string) => Promise<void>;
  onEdit: (taskId: string, patch: { title: string; details: string }, reasoning: string) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onShowHistory: (taskId: string) => void;
};

const PRIORITIES: TaskPriority[] = [1, 2, 3, 4, 5];

/**
 * The operator's control surface for a single item.
 *
 * Every control here asks for a reason, and that reason is what lands on the
 * audit trail next to the agents' own entries - so a later reviewer sees one
 * consistent history rather than a set of unexplained human overrides.
 */
export function TaskInspector({
  board,
  task,
  onClose,
  onReprioritise,
  onReassign,
  onEdit,
  onDelete,
  onShowHistory,
}: TaskInspectorProps) {
  const [reasoning, setReasoning] = useState('');
  const [title, setTitle] = useState(task.title);
  const [details, setDetails] = useState(task.details);
  const [busy, setBusy] = useState(false);

  // Re-sync when the operator selects a different card, or an agent changes this
  // one underneath us during a poll.
  useEffect(() => {
    setTitle(task.title);
    setDetails(task.details);
    setReasoning('');
  }, [task.id, task.title, task.details]);

  const holder = holderOf(board, task);
  const reserved = agentById(board, task.assignedAgentId);
  const blockedBy = blockedByTitles(board, task);
  const workers = board.agents.filter((agent) => agent.role === 'worker');

  const withReason = (fallback: string) => reasoning.trim() || fallback;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setReasoning('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={styles.inspector} data-testid="task-inspector">
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Work item</h2>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          Close
        </button>
      </div>

      <dl className={styles.factList}>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABELS[task.status]}</dd>
        </div>
        <div>
          <dt>Held by</dt>
          <dd>{holder ? holder.name : 'Nobody'}</dd>
        </div>
        <div>
          <dt>Lease until</dt>
          <dd>{task.lease ? formatTime(task.lease.expiresAt) : '-'}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{task.attempts}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>v{task.version}</dd>
        </div>
      </dl>

      {task.acceptanceCriteria.length > 0 ? (
        <div className={styles.inspectorBlock}>
          <h3 className={styles.inspectorHeading}>Acceptance criteria</h3>
          <ul className={styles.criteriaList}>
            {task.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {blockedBy.length > 0 ? (
        <div className={styles.inspectorBlock}>
          <h3 className={styles.inspectorHeading}>Waiting on</h3>
          <p className={styles.panelNote}>{blockedBy.join(', ')}</p>
        </div>
      ) : null}

      {task.result ? (
        <div className={styles.inspectorBlock}>
          <h3 className={styles.inspectorHeading}>Result from {task.result.producedBy}</h3>
          <p className={styles.panelNote}>{task.result.summary}</p>
          <pre className={styles.resultOutput}>{task.result.output}</pre>
        </div>
      ) : null}

      <div className={styles.inspectorBlock}>
        <label className={styles.fieldLabel} htmlFor="inspector-reason">
          Reason for your change
        </label>
        <textarea
          id="inspector-reason"
          className={styles.textArea}
          placeholder="Why are you changing this? Recorded on the audit trail."
          value={reasoning}
          onChange={(event) => setReasoning(event.target.value)}
        />
      </div>

      <div className={styles.inspectorBlock}>
        <h3 className={styles.inspectorHeading}>Priority</h3>
        <div className={styles.priorityRow}>
          {PRIORITIES.map((priority) => (
            <button
              key={priority}
              type="button"
              disabled={busy}
              className={`${styles.priorityButton} ${task.priority === priority ? styles.priorityActive : ''}`}
              onClick={() =>
                run(() =>
                  onReprioritise(
                    task.id,
                    priority,
                    withReason('Operator set priority to P' + priority + '.')
                  )
                )
              }
            >
              P{priority}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.inspectorBlock}>
        <h3 className={styles.inspectorHeading}>Assignment</h3>
        <p className={styles.panelNote}>
          {reserved ? 'Reserved for ' + reserved.name : 'Open to any agent'}
        </p>
        <select
          className={styles.selectField}
          disabled={busy}
          value={task.assignedAgentId ?? ''}
          onChange={(event) =>
            run(() =>
              onReassign(
                task.id,
                event.target.value || null,
                withReason(
                  event.target.value
                    ? 'Operator reserved this item for ' + event.target.value + '.'
                    : 'Operator returned this item to the open queue.'
                )
              )
            )
          }
        >
          <option value="">Any agent (open queue)</option>
          {workers.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.inspectorBlock}>
        <h3 className={styles.inspectorHeading}>Edit</h3>
        <input
          className={styles.inputField}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Task title"
        />
        <textarea
          className={styles.textArea}
          value={details}
          disabled={busy}
          onChange={(event) => setDetails(event.target.value)}
          aria-label="Task details"
        />
        <button
          type="button"
          className={styles.addButton}
          disabled={busy || (title === task.title && details === task.details)}
          onClick={() =>
            run(() =>
              onEdit(task.id, { title, details }, withReason('Operator rewrote the work item.'))
            )
          }
        >
          Save changes
        </button>
      </div>

      <div className={styles.inspectorFooter}>
        <button type="button" className={styles.linkButton} onClick={() => onShowHistory(task.id)}>
          View history
        </button>
        <button
          type="button"
          className={styles.dangerButton}
          disabled={busy}
          onClick={() => run(() => onDelete(task.id))}
        >
          Delete item
        </button>
      </div>
    </aside>
  );
}
