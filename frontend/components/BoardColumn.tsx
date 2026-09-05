"use client";

import { useDroppable } from '@dnd-kit/core';
import { CardItem } from '@/components/CardItem';
import { blockedByTitles, holderOf, agentById, type BoardColumnView } from '@/lib/board';
import type { BoardState } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

type BoardColumnProps = {
  column: BoardColumnView;
  board: BoardState;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
};

/**
 * One lifecycle stage. Columns are fixed because they are the lifecycle - an
 * operator cannot rename or add one without changing what the agents enforce.
 */
export function BoardColumn({ column, board, selectedTaskId, onSelectTask }: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <section
      ref={setNodeRef}
      className={`${styles.columnWrapper} ${isOver ? styles.dropActive : ''}`}
      aria-labelledby={`${column.id}-title`}
      data-testid={'column-' + column.id}
      role="region"
    >
      <div className={styles.columnHeader}>
        <div>
          <h2 id={`${column.id}-title`} className={styles.columnTitle}>
            {column.title}
          </h2>
          <p className={styles.columnHint}>{column.hint}</p>
        </div>
        <span className={styles.columnCount}>{column.tasks.length}</span>
      </div>

      <div className={styles.columnBody}>
        <div className={styles.cardsList}>
          {column.tasks.map((task) => (
            <CardItem
              key={task.id}
              task={task}
              holder={holderOf(board, task)}
              reservedFor={agentById(board, task.assignedAgentId)}
              blockedBy={blockedByTitles(board, task)}
              isSelected={task.id === selectedTaskId}
              onSelect={onSelectTask}
            />
          ))}

          {column.tasks.length === 0 ? (
            <p className={styles.emptyColumn}>Nothing here.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
