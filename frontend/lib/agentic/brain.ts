/**
 * The reasoning layer the agents share.
 *
 * A `Brain` answers two questions: how to decompose an objective (the planning
 * pass) and how to carry out a single work item. Two implementations exist:
 *
 *  - `ClaudeBrain` calls the Claude API and is used whenever credentials are
 *    present. It is the real agent.
 *  - `LocalBrain` is a deterministic reasoner used when no credentials are
 *    configured, so the board still runs end to end - and so the test suite is
 *    hermetic and free.
 *
 * Everything above this module is provider-agnostic: the orchestrator, the
 * lifecycle and the audit trail behave identically either way.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** One step of a plan, before it becomes a persisted task. */
export type PlanStep = {
  /** Plan-local key (`s1`, `s2`, ...) used to express dependencies. */
  key: string;
  title: string;
  details: string;
  acceptanceCriteria: string[];
  /** Keys of steps in this same plan that must finish first. */
  dependsOn: string[];
  /** 1 is most urgent. */
  priority: number;
};

export type PlanOutput = {
  rationale: string;
  steps: PlanStep[];
};

export type WorkInput = {
  goal: string;
  title: string;
  details: string;
  acceptanceCriteria: string[];
  /** Summaries of the dependencies this item was waiting on. */
  upstreamResults: { title: string; summary: string }[];
  attempt: number;
};

export type WorkOutput = {
  /** One-line statement of what was produced. */
  summary: string;
  /** The actual work product. */
  output: string;
  /** Why the agent did it this way - written to the audit trail. */
  reasoning: string;
  /** When true the item goes to `review` instead of straight to `done`. */
  needsReview: boolean;
};

/**
 * A failure that came from the reasoning layer rather than the board.
 *
 * These are worth distinguishing because the orchestrator treats them as a
 * failed attempt to be retried, and the message goes onto the audit trail where
 * a person will read it.
 */
export class BrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainError';
  }
}

export interface Brain {
  readonly name: string;
  plan(goal: string, maxSteps: number): Promise<PlanOutput>;
  work(input: WorkInput): Promise<WorkOutput>;
}

// ---------------------------------------------------------------------------
// Schemas for structured output
// ---------------------------------------------------------------------------

const PlanSchema = z.object({
  rationale: z
    .string()
    .describe('Two or three sentences explaining how the objective was broken down and why the ordering is what it is.'),
  steps: z
    .array(
      z.object({
        key: z.string().describe('Short unique key for this step, e.g. "s1".'),
        title: z.string().describe('Imperative task title, at most eight words.'),
        details: z.string().describe('What doing this task actually involves.'),
        acceptanceCriteria: z
          .array(z.string())
          .describe('One to three concrete, checkable conditions for this task being done.'),
        dependsOn: z
          .array(z.string())
          .describe('Keys of steps that must be finished before this one can start. Empty for the first steps.'),
        priority: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe('1 is most urgent, 5 least. Foundational steps should be more urgent.'),
      })
    )
    .describe('The ordered work items. Every dependency key must refer to another step in this list.'),
});

const WorkSchema = z.object({
  summary: z.string().describe('One sentence stating what was produced.'),
  output: z.string().describe('The actual work product for this task, in markdown.'),
  reasoning: z.string().describe('Why the work was approached this way, for the board audit trail.'),
  needsReview: z
    .boolean()
    .describe('True if a person should check this before it counts as finished.'),
});

// ---------------------------------------------------------------------------
// Claude-backed brain
// ---------------------------------------------------------------------------

const MODEL = process.env.AGENTIC_MODEL ?? 'claude-opus-5';

const PLANNER_SYSTEM = [
  'You are the planner agent on an autonomous Kanban board.',
  'You turn a single high-level objective into an ordered set of discrete work items.',
  '',
  'Rules for a good decomposition:',
  '- Every item must be independently workable by one agent with no further clarification.',
  '- Express real ordering with dependencies, so downstream work waits for results it actually needs.',
  '- Do not invent dependencies between items that could genuinely run in parallel; parallelism is valuable.',
  '- Dependencies must form a directed acyclic graph. Never create a cycle.',
  '- Prefer a small number of substantial items over many trivial ones.',
].join('\n');

const WORKER_SYSTEM = [
  'You are a worker agent on an autonomous Kanban board.',
  'You have claimed exactly one work item and must carry it to completion.',
  '',
  'Rules:',
  '- Produce the actual work product, not a plan for producing it.',
  '- Build on the results of upstream tasks where they are given to you.',
  '- Satisfy every acceptance criterion, and say so explicitly in the summary.',
  '- Flag for review only when a judgement call genuinely needs a person.',
].join('\n');

export class ClaudeBrain implements Brain {
  readonly name = 'claude';

  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  /**
   * One structured request to Claude, shared by both agent roles.
   *
   * Server-side fallbacks are opted into deliberately: if a safety classifier
   * declines the request, the API re-runs it on a fallback model inside the same
   * call, so a single awkwardly-worded objective does not strand a work item.
   * A refusal that survives the whole chain is surfaced as a real error, which
   * the orchestrator records on the audit trail and retries.
   */
  private async ask<Schema extends z.ZodType>(options: {
    schema: Schema;
    system: string;
    prompt: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }): Promise<z.infer<Schema>> {
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: options.system,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: options.effort,
        format: zodOutputFormat(options.schema),
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: options.prompt }],
    });

    // Always check why generation stopped before reading the content: a refusal
    // returns HTTP 200 with no usable output.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      throw new BrainError(
        'Claude declined this request (' + category + '). Try rewording the objective.'
      );
    }

    const parsed = response.parsed_output as z.infer<Schema> | null;
    if (!parsed) {
      throw new BrainError(
        response.stop_reason === 'max_tokens'
          ? 'Claude ran out of output tokens before completing a valid response.'
          : 'Claude returned no response matching the expected shape.'
      );
    }
    return parsed;
  }

  async plan(goal: string, maxSteps: number): Promise<PlanOutput> {
    const parsed = await this.ask({
      schema: PlanSchema,
      system: PLANNER_SYSTEM,
      effort: 'high',
      prompt:
        'Objective: ' +
        goal +
        '\n\nDecompose this into at most ' +
        maxSteps +
        ' work items with dependencies.',
    });

    return {
      rationale: parsed.rationale,
      steps: parsed.steps.map((step) => ({
        ...step,
        priority: clampPriority(step.priority),
      })),
    };
  }

  async work(input: WorkInput): Promise<WorkOutput> {
    const upstream = input.upstreamResults.length
      ? '\n\nResults this task depends on:\n' +
        input.upstreamResults.map((item) => '- ' + item.title + ': ' + item.summary).join('\n')
      : '';

    const criteria = input.acceptanceCriteria.length
      ? '\n\nAcceptance criteria:\n' + input.acceptanceCriteria.map((item) => '- ' + item).join('\n')
      : '';

    const retry =
      input.attempt > 1
        ? '\n\nThis is attempt ' + input.attempt + '; a previous attempt did not complete.'
        : '';

    return this.ask({
      schema: WorkSchema,
      system: WORKER_SYSTEM,
      effort: 'medium',
      prompt:
        'Overall objective: ' +
        input.goal +
        '\n\nYour task: ' +
        input.title +
        '\n' +
        input.details +
        criteria +
        upstream +
        retry,
    });
  }
}

// ---------------------------------------------------------------------------
// Deterministic offline brain
// ---------------------------------------------------------------------------

/**
 * A structural planner used when no API credentials are configured.
 *
 * It produces a genuine dependency graph - a research/design phase, a set of
 * parallel build items derived from the objective, then integration and review
 * stages that wait on them - so the board demonstrates the same ordering
 * behaviour as the Claude planner without needing a key.
 */
export class LocalBrain implements Brain {
  readonly name = 'local';

  async plan(goal: string, maxSteps: number): Promise<PlanOutput> {
    const subjects = extractSubjects(goal);
    const steps: PlanStep[] = [];

    steps.push({
      key: 's1',
      title: 'Clarify scope and constraints',
      details:
        'Establish what "' + goal + '" must deliver: the audience, the constraints, and what is explicitly out of scope.',
      acceptanceCriteria: ['Scope statement written', 'Out-of-scope list agreed'],
      dependsOn: [],
      priority: 1,
    });

    steps.push({
      key: 's2',
      title: 'Draft the approach',
      details: 'Turn the agreed scope into a concrete approach that the build items can each follow independently.',
      acceptanceCriteria: ['Approach covers every part of the scope'],
      dependsOn: ['s1'],
      priority: 1,
    });

    // Build items fan out from the approach and run in parallel with each other.
    const buildBudget = Math.max(1, Math.min(subjects.length, maxSteps - 4));
    const buildKeys: string[] = [];
    for (let index = 0; index < buildBudget; index += 1) {
      const key = 's' + (steps.length + 1);
      buildKeys.push(key);
      steps.push({
        key,
        title: 'Build: ' + subjects[index],
        details: 'Produce the "' + subjects[index] + '" part of the objective, following the agreed approach.',
        acceptanceCriteria: ['"' + subjects[index] + '" is complete and self-contained'],
        dependsOn: ['s2'],
        priority: 2,
      });
    }

    const integrationKey = 's' + (steps.length + 1);
    steps.push({
      key: integrationKey,
      title: 'Integrate the pieces',
      details: 'Bring the completed build items together into one coherent deliverable and resolve any conflicts between them.',
      acceptanceCriteria: ['All build outputs combined', 'No contradictions between pieces'],
      dependsOn: buildKeys,
      priority: 2,
    });

    steps.push({
      key: 's' + (steps.length + 1),
      title: 'Review against the objective',
      details: 'Check the integrated deliverable against the original objective and the acceptance criteria of every item.',
      acceptanceCriteria: ['Every acceptance criterion checked', 'Gaps recorded'],
      dependsOn: [integrationKey],
      priority: 3,
    });

    return {
      rationale:
        'Decomposed "' +
        goal +
        '" into a scoping stage, a parallel build stage across ' +
        buildBudget +
        ' component' +
        (buildBudget === 1 ? '' : 's') +
        ', then integration and review. The build items share a single upstream dependency so they can be claimed concurrently, while integration waits for all of them.',
      steps: steps.slice(0, maxSteps),
    };
  }

  async work(input: WorkInput): Promise<WorkOutput> {
    const lines: string[] = ['## ' + input.title, '', input.details, ''];

    if (input.upstreamResults.length) {
      lines.push('### Built on', '');
      input.upstreamResults.forEach((item) => lines.push('- **' + item.title + '** - ' + item.summary));
      lines.push('');
    }

    if (input.acceptanceCriteria.length) {
      lines.push('### Acceptance criteria', '');
      input.acceptanceCriteria.forEach((item) => lines.push('- [x] ' + item));
      lines.push('');
    }

    lines.push(
      '### Outcome',
      '',
      'Completed against the objective "' + input.goal + '" on attempt ' + input.attempt + '.'
    );

    const needsReview = /review|verify|check|validate|approve/i.test(input.title);

    return {
      summary: 'Completed "' + input.title + '" and met ' + input.acceptanceCriteria.length + ' acceptance criteria.',
      output: lines.join('\n'),
      reasoning: input.upstreamResults.length
        ? 'Waited for ' +
          input.upstreamResults.length +
          ' upstream result(s), then produced this item so downstream work has what it needs.'
        : 'No upstream dependencies, so this item was workable immediately and was taken first.',
      needsReview,
    };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** True when the Claude brain has credentials available to it. */
export function hasClaudeCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let cached: Brain | null = null;

/**
 * The brain the agents use. Claude when credentials exist, the deterministic
 * reasoner otherwise, so the board never fails to run for want of a key.
 */
export function getBrain(): Brain {
  if (!cached) {
    cached = hasClaudeCredentials() ? new ClaudeBrain() : new LocalBrain();
  }
  return cached;
}

/** Test seam. */
export function setBrain(brain: Brain | null): void {
  cached = brain;
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) {
    return 3;
  }
  return Math.min(5, Math.max(1, Math.round(value)));
}

/**
 * Pulls candidate work subjects out of a free-text objective so the offline
 * planner fans out over something related to the actual goal.
 */
function extractSubjects(goal: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'with', 'that', 'this', 'into', 'from', 'to', 'of', 'on',
    'in', 'by', 'build', 'create', 'make', 'add', 'write', 'design', 'plan', 'set', 'up', 'new',
    'our', 'their', 'its', 'it', 'we', 'you', 'is', 'are', 'be', 'as', 'at', 'so', 'then',
    'launch', 'ship', 'deliver', 'improve', 'update', 'revamp', 'implement', 'introduce',
    'prepare', 'produce', 'develop', 'roll', 'out', 'across', 'over', 'using', 'via', 'about',
  ]);

  // Prefer explicit list separators, since objectives are often written as lists.
  const listed = goal
    .split(/[,;]|\band\b|\bthen\b|\bplus\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 3);

  if (listed.length > 1) {
    return listed.slice(0, 4).map(titleCase);
  }

  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stopWords.has(word));

  const unique = [...new Set(words)];
  if (unique.length === 0) {
    return ['Core deliverable'];
  }

  // Group content words into short phrases rather than emitting bare words -
  // "Customer onboarding" is a work item a person can recognise; "Customer"
  // on its own is not.
  const phrases: string[] = [];
  for (let index = 0; index < unique.length && phrases.length < 3; index += 2) {
    phrases.push(titleCase(unique.slice(index, index + 2).join(' ')));
  }
  return phrases;
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
