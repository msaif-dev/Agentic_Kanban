// @vitest-environment node
// These exercise server-side modules; jsdom would make the SDK refuse to load.
import { describe, expect, it, vi } from 'vitest';
import { BrainError, ClaudeBrain } from '@/lib/agentic/brain';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * These exercise the Claude code path without spending money or needing a key.
 *
 * A fake client stands in for the SDK, so the request this app actually builds
 * is executed and inspected. That catches everything except how the server
 * responds - wrong parameter nesting, a dropped field, mishandled refusals -
 * which is the class of bug that would otherwise only surface on the first real
 * call a user makes.
 */
function fakeClient(reply: unknown) {
  const parse = vi.fn().mockResolvedValue(reply);
  return {
    client: { beta: { messages: { parse } } } as unknown as Anthropic,
    parse,
  };
}

const PLAN_REPLY = {
  stop_reason: 'end_turn',
  stop_details: null,
  parsed_output: {
    rationale: 'Split into a research step and a build step.',
    steps: [
      {
        key: 's1',
        title: 'Research the options',
        details: 'Survey what exists.',
        acceptanceCriteria: ['Options written up'],
        dependsOn: [],
        priority: 1,
      },
      {
        key: 's2',
        title: 'Build the chosen option',
        details: 'Implement it.',
        acceptanceCriteria: ['It works'],
        dependsOn: ['s1'],
        priority: 2,
      },
    ],
  },
};

const WORK_REPLY = {
  stop_reason: 'end_turn',
  stop_details: null,
  parsed_output: {
    summary: 'Wrote the onboarding guide.',
    output: '# Guide\n\nSteps...',
    reasoning: 'Followed the agreed outline.',
    needsReview: false,
  },
};

describe('the request sent to Claude', () => {
  it('uses the configured model with adaptive thinking and a structured format', async () => {
    const { client, parse } = fakeClient(PLAN_REPLY);
    await new ClaudeBrain(client).plan('Ship onboarding', 6);

    const params = parse.mock.calls[0][0];
    expect(params.model).toBe('claude-opus-5');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.max_tokens).toBeGreaterThanOrEqual(16000);

    // effort and format both live inside output_config, not at the top level.
    expect(params.output_config.effort).toBe('high');
    expect(params.output_config.format).toBeDefined();
    expect(params).not.toHaveProperty('effort');
    expect(params).not.toHaveProperty('output_format');
  });

  it('opts into server-side refusal fallbacks with the matching beta flag', async () => {
    const { client, parse } = fakeClient(PLAN_REPLY);
    await new ClaudeBrain(client).plan('Ship onboarding', 6);

    const params = parse.mock.calls[0][0];
    // The scalar "default" form pairs with the -07-01 header; mixing the forms
    // is a 400, so these two must move together.
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toContain('server-side-fallback-2026-07-01');
  });

  it('sends the goal and the step ceiling to the planner', async () => {
    const { client, parse } = fakeClient(PLAN_REPLY);
    await new ClaudeBrain(client).plan('Ship onboarding', 6);

    const params = parse.mock.calls[0][0];
    expect(params.system).toContain('planner agent');
    expect(params.messages[0].role).toBe('user');
    expect(params.messages[0].content).toContain('Ship onboarding');
    expect(params.messages[0].content).toContain('at most 6');
  });

  it('gives the worker its upstream results, criteria and attempt count', async () => {
    const { client, parse } = fakeClient(WORK_REPLY);
    await new ClaudeBrain(client).work({
      goal: 'Ship onboarding',
      title: 'Write the guide',
      details: 'Cover the first-run experience.',
      acceptanceCriteria: ['Covers sign-up', 'Covers first login'],
      upstreamResults: [{ title: 'Research', summary: 'Three options compared.' }],
      attempt: 2,
    });

    const prompt = parse.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Write the guide');
    expect(prompt).toContain('Covers sign-up');
    expect(prompt).toContain('Research: Three options compared.');
    expect(prompt).toContain('attempt 2');
    expect(parse.mock.calls[0][0].output_config.effort).toBe('medium');
  });

  it('omits the upstream and retry sections when there is nothing to say', async () => {
    const { client, parse } = fakeClient(WORK_REPLY);
    await new ClaudeBrain(client).work({
      goal: 'Ship onboarding',
      title: 'First task',
      details: '',
      acceptanceCriteria: [],
      upstreamResults: [],
      attempt: 1,
    });

    const prompt = parse.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain('Results this task depends on');
    expect(prompt).not.toContain('Acceptance criteria');
    expect(prompt).not.toContain('This is attempt');
  });
});

describe('reading the response', () => {
  it('maps a plan through, clamping an out-of-range priority', async () => {
    const { client } = fakeClient({
      ...PLAN_REPLY,
      parsed_output: {
        ...PLAN_REPLY.parsed_output,
        steps: [
          { ...PLAN_REPLY.parsed_output.steps[0], priority: 99 },
          { ...PLAN_REPLY.parsed_output.steps[1], priority: 0 },
        ],
      },
    });

    const plan = await new ClaudeBrain(client).plan('Ship onboarding', 6);
    expect(plan.rationale).toBe('Split into a research step and a build step.');
    expect(plan.steps.map((step) => step.priority)).toEqual([5, 1]);
    expect(plan.steps[1].dependsOn).toEqual(['s1']);
  });

  it('returns the worker result unchanged', async () => {
    const { client } = fakeClient(WORK_REPLY);
    const result = await new ClaudeBrain(client).work({
      goal: 'g',
      title: 't',
      details: '',
      acceptanceCriteria: [],
      upstreamResults: [],
      attempt: 1,
    });
    expect(result.summary).toBe('Wrote the onboarding guide.');
    expect(result.needsReview).toBe(false);
  });

  it('reports a refusal as a refusal, naming the category', async () => {
    const { client } = fakeClient({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' },
      parsed_output: null,
    });

    await expect(new ClaudeBrain(client).plan('Do something dodgy', 6)).rejects.toThrow(
      /declined this request \(cyber\)/
    );
  });

  it('survives a refusal that carries no stop_details', async () => {
    const { client } = fakeClient({
      stop_reason: 'refusal',
      stop_details: null,
      parsed_output: null,
    });
    await expect(new ClaudeBrain(client).plan('Anything', 6)).rejects.toThrow(/unspecified/);
  });

  it('distinguishes a truncated response from an unparseable one', async () => {
    const truncated = fakeClient({
      stop_reason: 'max_tokens',
      stop_details: null,
      parsed_output: null,
    });
    await expect(new ClaudeBrain(truncated.client).plan('Anything', 6)).rejects.toThrow(
      /ran out of output tokens/
    );

    const unparseable = fakeClient({
      stop_reason: 'end_turn',
      stop_details: null,
      parsed_output: null,
    });
    await expect(new ClaudeBrain(unparseable.client).plan('Anything', 6)).rejects.toThrow(
      /no response matching the expected shape/
    );
  });

  it('raises BrainError, so the orchestrator can tell it from a board error', async () => {
    const { client } = fakeClient({
      stop_reason: 'refusal',
      stop_details: null,
      parsed_output: null,
    });
    await expect(new ClaudeBrain(client).plan('Anything', 6)).rejects.toBeInstanceOf(BrainError);
  });
});

describe('brain selection', () => {
  it('picks Claude only when credentials are present', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    try {
      vi.resetModules();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      const offline = await import('@/lib/agentic/brain');
      expect(offline.hasClaudeCredentials()).toBe(false);
      expect(offline.getBrain().name).toBe('local');

      vi.resetModules();
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const online = await import('@/lib/agentic/brain');
      expect(online.hasClaudeCredentials()).toBe(true);
      expect(online.getBrain().name).toBe('claude');
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previous;
      }
    }
  });
});
