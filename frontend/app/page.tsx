"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { AgentRoster } from '@/components/AgentRoster';
import { AuditTrail } from '@/components/AuditTrail';
import { BoardColumn } from '@/components/BoardColumn';
import { ObjectivePanel } from '@/components/ObjectivePanel';
import { TaskInspector } from '@/components/TaskInspector';
import * as api from '@/lib/api';
import { BOARD_COLUMNS, STATUS_LABELS, summarise, taskById, toColumns } from '@/lib/board';
import type { BoardState, TaskPriority, TaskStatus } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

/** How often the board is re-read while agents are running. */
const POLL_INTERVAL_MS = 1_000;

export default function Home() {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [selectedObjectiveId, setSelectedObjectiveId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [workerCount, setWorkerCount] = useState(2);

  // Both sensors, so every drag the mouse can do is reachable from the keyboard:
  // tab to a card, space to pick it up, arrows to move, space to drop.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  // Tracks whether a refresh is already in flight, so a slow response cannot
  // stack up a queue of overlapping polls.
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) {
      return;
    }
    refreshing.current = true;
    try {
      const next = await api.fetchBoard();
      setBoard(next);
      setError(null);
      setSelectedObjectiveId((current) => {
        if (current && next.objectives.some((objective) => objective.id === current)) {
          return current;
        }
        return next.objectives.at(-1)?.id ?? null;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the board.');
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while the run is live; a stopped board only changes when we change it.
  useEffect(() => {
    if (!board?.run.running) {
      return;
    }
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [board?.run.running, refresh]);

  /** Runs a mutation, surfaces its error, and re-reads the board either way. */
  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That change was rejected.');
      } finally {
        await refresh();
      }
    },
    [refresh]
  );

  const submitObjective = useCallback(
    async (goal: string) => {
      setPlanning(true);
      try {
        const { objective } = await api.submitObjective(goal);
        setSelectedObjectiveId(objective.id);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Planning failed.');
      } finally {
        setPlanning(false);
        await refresh();
      }
    },
    [refresh]
  );

  const columns = useMemo(
    () => (board ? toColumns(board.tasks, selectedObjectiveId) : []),
    [board, selectedObjectiveId]
  );

  const progress = useMemo(() => {
    if (!board) {
      return null;
    }
    const scoped = selectedObjectiveId
      ? board.tasks.filter((task) => task.objectiveId === selectedObjectiveId)
      : board.tasks;
    return summarise(scoped);
  }, [board, selectedObjectiveId]);

  const selectedTask = board ? taskById(board, selectedTaskId) : null;

  /**
   * Drag has two meanings, decided by what the card was dropped on.
   *
   * Onto a column: an operator override that moves the item to that lifecycle
   * stage regardless of who holds it. Onto another card in the same column:
   * a reorder, which rewrites queue rank and so changes what the next agent
   * picks up.
   */
  const handleDragEnd = (event: DragEndEvent) => {
    if (!board || !event.over) {
      return;
    }

    const taskId = String(event.active.id);
    const task = taskById(board, taskId);
    if (!task) {
      return;
    }

    const overData = event.over.data.current as { taskId?: string; status?: TaskStatus } | undefined;

    // Dropped onto another card: reorder within that column.
    if (overData?.taskId && overData.taskId !== taskId) {
      if (overData.status !== task.status) {
        // Crossing lanes card-to-card is a stage change, not a reorder.
        void mutate(() =>
          api.moveTask(
            taskId,
            overData.status as TaskStatus,
            'Operator dragged this item into ' + STATUS_LABELS[overData.status as TaskStatus] + '.'
          )
        );
        return;
      }

      const lane = columns.find((column) => column.id === task.status);
      if (!lane) {
        return;
      }

      const order = lane.tasks.map((item) => item.id);
      const from = order.indexOf(taskId);
      const to = order.indexOf(overData.taskId);
      if (from === -1 || to === -1) {
        return;
      }
      order.splice(to, 0, ...order.splice(from, 1));

      void mutate(() =>
        api.reorderQueue(
          order,
          'Operator reordered the ' + STATUS_LABELS[task.status] + ' queue.'
        )
      );
      return;
    }

    // Dropped onto a column: move the item to that stage.
    const destination = BOARD_COLUMNS.find((column) => column.id === String(event.over!.id));
    if (!destination || task.status === destination.id) {
      return;
    }

    void mutate(() =>
      api.moveTask(
        taskId,
        destination.id as TaskStatus,
        'Operator dragged this item to ' + destination.title + '.'
      )
    );
  };

  if (!board) {
    return (
      <main className={styles.pageContainer}>
        <p className={styles.description}>{error ?? 'Loading the board...'}</p>
      </main>
    );
  }

  const running = board.run.running;

  return (
    <main className={styles.pageContainer}>
      <section className={styles.headerSection}>
        <div>
          <p className={styles.subheading}>Agentic Kanban</p>
          <h1 className={styles.title}>Autonomous Task Board</h1>
          <p className={styles.description}>
            A planner agent decomposes an objective into ordered work items. Worker agents claim
            them independently and carry them to completion - nobody hands out the work. You stay in
            control: reprioritise, reassign or edit at any point, and the agents continue from what
            you changed.
          </p>
        </div>

        <div className={styles.runPanel}>
          <div className={styles.runStatus} data-running={running}>
            <span className={styles.runDot} aria-hidden />
            {running ? 'Agents running' : 'Agents stopped'}
          </div>

          <label className={styles.workerField}>
            Workers
            <input
              type="number"
              min={1}
              max={6}
              className={styles.numberInput}
              value={workerCount}
              disabled={running}
              onChange={(event) => setWorkerCount(Number(event.target.value))}
            />
          </label>

          <div className={styles.runButtons}>
            <button
              type="button"
              className={styles.addButton}
              onClick={() =>
                void mutate(() => api.controlRun(running ? 'stop' : 'start', workerCount))
              }
            >
              {running ? 'Stop' : 'Start run'}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={running}
              title="Advance exactly one claim-work-release cycle"
              onClick={() => void mutate(() => api.controlRun('step'))}
            >
              Step once
            </button>
          </div>

          {progress ? (
            <p className={styles.runProgress}>
              {progress.done}/{progress.total} done - {progress.active} in flight -{' '}
              {progress.blocked} blocked
              {progress.failed > 0 ? ' - ' + progress.failed + ' failed' : ''}
            </p>
          ) : null}
        </div>
      </section>

      {error ? (
        <p className={styles.errorBanner} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <ObjectivePanel
            board={board}
            selectedObjectiveId={selectedObjectiveId}
            planning={planning}
            onSelectObjective={setSelectedObjectiveId}
            onSubmitObjective={submitObjective}
            onAddTask={(objectiveId, title, details) =>
              mutate(() => api.addTask(objectiveId, title, details, 2))
            }
          />
          <AgentRoster board={board} />
        </div>

        <div className={styles.boardArea}>
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <div className={styles.boardFrame}>
              <div className={styles.boardGrid}>
                {columns.map((column) => (
                  <BoardColumn
                    key={column.id}
                    column={column}
                    board={board}
                    selectedTaskId={selectedTaskId}
                    onSelectTask={setSelectedTaskId}
                  />
                ))}
              </div>
            </div>
          </DndContext>
        </div>

        <div className={styles.sidebar}>
          {selectedTask ? (
            <TaskInspector
              board={board}
              task={selectedTask}
              onClose={() => setSelectedTaskId(null)}
              onShowHistory={setHistoryTaskId}
              onReprioritise={(taskId, priority: TaskPriority, reasoning) =>
                mutate(() => api.reprioritiseTask(taskId, priority, reasoning))
              }
              onReassign={(taskId, agentId, reasoning) =>
                mutate(() => api.reassignTask(taskId, agentId, reasoning))
              }
              onEdit={(taskId, patch, reasoning) =>
                mutate(() => api.editTask(taskId, patch, reasoning))
              }
              onDelete={async (taskId) => {
                setSelectedTaskId(null);
                await mutate(() => api.deleteTask(taskId));
              }}
            />
          ) : null}

          <AuditTrail
            board={board}
            focusTaskId={historyTaskId}
            onClearFocus={() => setHistoryTaskId(null)}
          />
        </div>
      </div>
    </main>
  );
}
