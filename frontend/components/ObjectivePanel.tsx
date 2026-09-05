"use client";

import { useState } from 'react';
import { summarise } from '@/lib/board';
import type { BoardState, Objective } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

type ObjectivePanelProps = {
  board: BoardState;
  selectedObjectiveId: string | null;
  planning: boolean;
  onSelectObjective: (objectiveId: string) => void;
  onSubmitObjective: (goal: string) => Promise<void>;
  onAddTask: (objectiveId: string, title: string, details: string) => Promise<void>;
};

/**
 * Where an objective enters the board.
 *
 * Submitting a goal runs the planning pass, so the operator's single input is a
 * sentence and the output is an ordered set of work items with dependencies.
 */
export function ObjectivePanel({
  board,
  selectedObjectiveId,
  planning,
  onSelectObjective,
  onSubmitObjective,
  onAddTask,
}: ObjectivePanelProps) {
  const [goal, setGoal] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualDetails, setManualDetails] = useState('');
  const [addingTask, setAddingTask] = useState(false);

  const submit = async () => {
    const trimmed = goal.trim();
    if (!trimmed || planning) {
      return;
    }
    await onSubmitObjective(trimmed);
    setGoal('');
  };

  const selected = board.objectives.find((item) => item.id === selectedObjectiveId) ?? null;

  const addTask = async () => {
    const title = manualTitle.trim();
    if (!title || !selected || addingTask) {
      return;
    }
    setAddingTask(true);
    try {
      await onAddTask(selected.id, title, manualDetails.trim());
      setManualTitle('');
      setManualDetails('');
    } finally {
      setAddingTask(false);
    }
  };

  return (
    <div className={styles.panel}>
      <h2 className={styles.panelTitle}>Objective</h2>

      <div className={styles.objectiveForm}>
        <textarea
          className={styles.textArea}
          placeholder="Describe a goal, e.g. Launch the customer onboarding revamp"
          value={goal}
          disabled={planning}
          aria-label="Objective goal"
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              void submit();
            }
          }}
        />
        <button
          type="button"
          className={styles.addButton}
          disabled={planning || !goal.trim()}
          onClick={() => void submit()}
        >
          {planning ? 'Planning...' : 'Plan this objective'}
        </button>
      </div>

      {board.objectives.length > 0 ? (
        <ul className={styles.objectiveList}>
          {board.objectives.map((objective) => (
            <ObjectiveRow
              key={objective.id}
              objective={objective}
              board={board}
              isSelected={objective.id === selectedObjectiveId}
              onSelect={onSelectObjective}
            />
          ))}
        </ul>
      ) : null}

      {selected?.planRationale ? (
        <div className={styles.rationale}>
          <h3 className={styles.inspectorHeading}>Why the plan looks like this</h3>
          <p className={styles.panelNote}>{selected.planRationale}</p>
        </div>
      ) : null}

      {selected ? (
        <div className={styles.inspectorBlock}>
          <h3 className={styles.inspectorHeading}>Add a work item</h3>
          <p className={styles.panelNote}>
            Goes into the queue alongside the planner&rsquo;s items, ready for any agent to claim.
          </p>
          <input
            className={styles.inputField}
            placeholder="Title"
            aria-label="New task title"
            value={manualTitle}
            disabled={addingTask}
            onChange={(event) => setManualTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void addTask();
              }
            }}
          />
          <textarea
            className={styles.textArea}
            placeholder="What does this involve?"
            aria-label="New task details"
            value={manualDetails}
            disabled={addingTask}
            onChange={(event) => setManualDetails(event.target.value)}
          />
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={addingTask || !manualTitle.trim()}
            onClick={() => void addTask()}
          >
            {addingTask ? 'Adding...' : 'Add to queue'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ObjectiveRow({
  objective,
  board,
  isSelected,
  onSelect,
}: {
  objective: Objective;
  board: BoardState;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const progress = summarise(board.tasks.filter((task) => task.objectiveId === objective.id));

  return (
    <li>
      <button
        type="button"
        className={`${styles.objectiveRow} ${isSelected ? styles.objectiveActive : ''}`}
        onClick={() => onSelect(objective.id)}
        data-testid="objective-row"
      >
        <span className={styles.objectiveGoal}>{objective.goal}</span>
        <span className={styles.objectiveMeta}>
          <span className={styles.statusChip} data-objective-status={objective.status}>
            {objective.status}
          </span>
          <span className={styles.objectiveProgress}>
            {progress.done}/{progress.total}
          </span>
        </span>
        <span className={styles.progressTrack} aria-hidden>
          <span className={styles.progressFill} style={{ width: progress.percent + '%' }} />
        </span>
      </button>
    </li>
  );
}
