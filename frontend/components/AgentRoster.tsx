"use client";

import { taskById } from '@/lib/board';
import type { BoardState } from '@/lib/agentic/types';
import styles from '@/styles/page.module.css';

/**
 * Who is on the board and what each one is doing.
 *
 * This is the view that makes the autonomy legible: an operator can see that
 * nobody handed out the work, and still tell exactly which agent has which item.
 */
export function AgentRoster({ board }: { board: BoardState }) {
  if (board.agents.length === 0) {
    return (
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Agents</h2>
        <p className={styles.panelEmpty}>No agents yet. Submit an objective to bring them online.</p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.panelTitle}>Agents</h2>
      <ul className={styles.agentList}>
        {board.agents.map((agent) => {
          const current = taskById(board, agent.currentTaskId);
          return (
            <li key={agent.id} className={styles.agentRow} data-testid={'agent-' + agent.id}>
              <div className={styles.agentIdentity}>
                <span className={styles.agentDot} data-status={agent.status} aria-hidden />
                <div>
                  <p className={styles.agentName}>{agent.name}</p>
                  <p className={styles.agentRole}>{agent.role}</p>
                </div>
              </div>
              <div className={styles.agentState}>
                <p className={styles.agentActivity}>
                  {current ? 'Working: ' + current.title : agent.activity ?? 'Idle'}
                </p>
                <p className={styles.agentCount}>
                  {agent.tasksCompleted} completed
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
