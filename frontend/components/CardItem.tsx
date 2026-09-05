"use client";

import { useCallback } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { STATUS_LABELS } from '@/lib/board';
import type { Agent, Task } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

type CardItemProps = {
  task: Task;
  /** The agent holding the lease, if any. */
  holder: Agent | null;
  /** The agent a person has reserved this item for, if any. */
  reservedFor: Agent | null;
  blockedBy: string[];
  isSelected: boolean;
  onSelect: (taskId: string) => void;
};

/** Droppable id for a card, kept distinct from its draggable id. */
export function cardDropId(taskId: string): string {
  return 'over:' + taskId;
}

/**
 * One work item.
 *
 * The card leads with what an operator needs to judge the board at a glance:
 * who holds it, how urgent it is, and what it is waiting on.
 *
 * Each card is both draggable and a drop target: dropping one card onto another
 * in the same column reorders the queue, while dropping onto a column moves the
 * item to that stage. Dragging is disabled while an agent holds the lease -
 * taking work out from under a working agent is done deliberately through the
 * detail panel, not by accident.
 */
export function CardItem({
  task,
  holder,
  reservedFor,
  blockedBy,
  isSelected,
  onSelect,
}: CardItemProps) {
  const heldByAgent = Boolean(holder);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: heldByAgent,
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: cardDropId(task.id),
    data: { taskId: task.id, status: task.status },
  });

  // One element is both the drag handle and the drop target.
  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setDropRef(node);
    },
    [setNodeRef, setDropRef]
  );

  const style = {
    transform: transform ? 'translate3d(' + transform.x + 'px, ' + transform.y + 'px, 0)' : undefined,
    opacity: isDragging ? 0.55 : 1,
  };

  const classes = [
    styles.cardItem,
    isSelected ? styles.cardSelected : '',
    task.status === 'failed' ? styles.cardFailed : '',
    heldByAgent ? styles.cardHeld : '',
    isOver && !isDragging ? styles.cardDropTarget : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      ref={setRefs}
      className={classes}
      style={style}
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
      {...attributes}
      {...listeners}
    >
      <div className={styles.cardTop}>
        <h3 className={styles.cardTitle}>{task.title}</h3>
        <span className={styles.priorityBadge} title={'Priority ' + task.priority}>
          P{task.priority}
        </span>
      </div>

      {task.details ? <p className={styles.cardDetails}>{task.details}</p> : null}

      <div className={styles.cardMeta}>
        <span className={styles.statusChip} data-status={task.status}>
          {STATUS_LABELS[task.status]}
        </span>

        {holder ? (
          <span className={styles.agentChip} title="Holds the lease on this item">
            {holder.name}
          </span>
        ) : null}

        {!holder && reservedFor ? (
          <span className={styles.reservedChip} title="Reserved by the operator">
            for {reservedFor.name}
          </span>
        ) : null}

        {task.pinnedByHuman ? (
          <span className={styles.humanChip} title="Changed by the operator">
            edited
          </span>
        ) : null}

        {task.attempts > 1 ? (
          <span className={styles.attemptChip} title="Attempts so far">
            try {task.attempts}
          </span>
        ) : null}
      </div>

      {blockedBy.length > 0 ? (
        <p className={styles.blockedNote}>Waiting on: {blockedBy.join(', ')}</p>
      ) : null}

      {task.result ? <p className={styles.resultNote}>{task.result.summary}</p> : null}

      <button
        type="button"
        className={styles.cardOpen}
        // Drag listeners live on the article, so stop the click from starting one.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(task.id);
        }}
      >
        Details
      </button>
    </article>
  );
}
