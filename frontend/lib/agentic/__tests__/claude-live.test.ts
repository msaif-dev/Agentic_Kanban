// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ClaudeBrain } from '@/lib/agentic/brain';
import { findCycles } from '@/lib/agentic/lifecycle';
import { makeTask } from '@/lib/agentic/__tests__/harness';

/**
 * The only test in this suite that spends money.
 *
 * It is skipped unless credentials are present, so `npm test` stays free and
 * offline; `npm run verify:claude` with a key set runs it. Everything else about
 * the Claude path is covered by `claude-brain.test.ts` against a fake client -
 * what this adds is the one thing a fake cannot: proof that the real API accepts
 * the request we build and returns something we can use.
 */
const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

describe.skipIf(!hasCredentials)('Claude, for real', () => {
  it('plans an objective into a usable, acyclic dependency graph', async () => {
    const plan = await new ClaudeBrain().plan('Launch a customer onboarding revamp', 6);

    expect(plan.rationale.length).toBeGreaterThan(20);
    expect(plan.steps.length).toBeGreaterThan(1);
    expect(plan.steps.length).toBeLessThanOrEqual(6);

    // Keys must be unique, and every dependency must point at a real sibling.
    const keys = plan.steps.map((step) => step.key);
    expect(new Set(keys).size).toBe(keys.length);
    plan.steps.forEach((step) => {
      expect(step.title.trim()).not.toBe('');
      expect(step.priority).toBeGreaterThanOrEqual(1);
      expect(step.priority).toBeLessThanOrEqual(5);
      step.dependsOn.forEach((key) => expect(keys).toContain(key));
    });

    // At least one step must be startable, or the board would deadlock.
    expect(plan.steps.some((step) => step.dependsOn.length === 0)).toBe(true);

    // The graph the planner returned must be acyclic on its own merits, not
    // only after the board's repair pass.
    const asTasks = plan.steps.map((step) =>
      makeTask({ id: step.key, dependsOn: step.dependsOn })
    );
    expect(findCycles(asTasks)).toEqual([]);

    console.log('\nPlan:\n' + plan.steps.map((s) => '  - ' + s.title).join('\n'));
  }, 180_000);

  it('carries out a single work item and builds on its upstream result', async () => {
    const result = await new ClaudeBrain().work({
      goal: 'Launch a customer onboarding revamp',
      title: 'Write the welcome email sequence',
      details: 'Three emails covering sign-up, first login, and first success.',
      acceptanceCriteria: ['Three emails drafted', 'Each has a subject line'],
      upstreamResults: [
        { title: 'Define the onboarding stages', summary: 'Agreed on sign-up, activation, habit.' },
      ],
      attempt: 1,
    });

    expect(result.summary.trim()).not.toBe('');
    expect(result.output.length).toBeGreaterThan(100);
    expect(result.reasoning.trim()).not.toBe('');
    expect(typeof result.needsReview).toBe('boolean');

    console.log('\nWorker summary: ' + result.summary);
  }, 180_000);
});

describe.skipIf(hasCredentials)('Claude, for real', () => {
  it('is skipped because no credentials are set', () => {
    // Present so the run reports why the live checks did not happen, rather
    // than silently showing zero tests.
    expect(hasCredentials).toBe(false);
  });
});
