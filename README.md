# Agentic Kanban — Autonomous Task Board

A Kanban board that runs itself. You give it one objective; a **planner agent** decomposes it into
ordered work items with dependencies, and a pool of **worker agents** claim those items and carry
them to completion without anyone assigning individual pieces of work. You stay in control of the
board throughout — reprioritise, reassign or edit at any point, and the agents continue from the
updated state rather than from their original plan.

Built with Next.js 14 (App Router) and TypeScript. The agents call the Claude API when credentials
are available, and fall back to a deterministic local reasoner when they are not, so the board runs
end to end either way.

---

## Quick start

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

Then:

1. Type an objective — e.g. *"Launch the customer onboarding revamp"* — and press **Plan this
   objective**. The planner produces ordered work items; the ones with no dependencies appear in
   **Ready**, the rest in **Blocked**.
2. Press **Start run**. Worker agents begin claiming and completing items on their own.
3. Watch the **Audit trail** to see which agent did what, and why.

Press **Step once** instead of **Start run** to advance exactly one claim → work → release cycle,
which makes the protocol easy to watch item by item.

### Using Claude

The board uses the Claude API for both agent roles when credentials are present:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run verify:claude   # one planning call + one work call against the real API
npm run dev
```

`verify:claude` is the fastest way to confirm the Claude path end to end. It is skipped
automatically when no key is set, so `npm test` stays free and offline.

With no key set, a deterministic local reasoner stands in. It produces a genuine dependency graph —
a scoping stage, a parallel build stage, then integration and review — so every behaviour described
below is observable without an API key. Its task titles are derived from keywords in your objective,
so they read less naturally than the Claude planner's.

| Variable            | Default            | Purpose                                  |
| ------------------- | ------------------ | ---------------------------------------- |
| `ANTHROPIC_API_KEY` | *(unset)*          | Switches the agents onto the Claude API. |
| `AGENTIC_MODEL`     | `claude-opus-5`    | Model both agent roles use.              |
| `AGENTIC_DATA_DIR`  | `frontend/.data`   | Where the persisted board lives.         |

---

## How it works

### The planning pass

Submitting an objective runs one planning pass (`lib/agentic/planner.ts`). The planner returns steps
with plan-local keys (`s1`, `s2`, …) and dependencies expressed between those keys; the board
resolves them to real task ids once every item exists. A plan containing a dependency cycle is
repaired rather than accepted — the offending edges are dropped and the repair is recorded — because
a cycle would otherwise leave every task in it permanently blocked.

Re-planning an objective that already has work items is a no-op, so a second pass can never duplicate
or overwrite work the agents may already hold.

### The lifecycle

Every work item moves through an explicit lifecycle, and the board columns *are* that lifecycle:

```
planned ──► ready ──► claimed ──► in_progress ──► review ──► done
              ▲          │             │            │
              │          └── failed ───┴────────────┘
           blocked  (dependencies unmet — derived, never set by hand)
```

Two rules make the board safe to run concurrently:

- **An agent must claim an item before working it.** `transitionTask` refuses to move an item for an
  agent that does not hold its lease, so an agent cannot mark something done that it never took.
- **A claim is an atomic compare-and-swap.** Every task carries a `version`; an agent claims by
  presenting the version it read. If anything changed in between — another agent got there first, or
  you reprioritised the item — the claim is refused and the agent re-decides against fresh state.

Claims are **leased** (60s, renewed while work is in flight). If a worker dies mid-task the lease
lapses and the item returns to the queue, so a crash cannot strand work.

`ready`/`blocked` is derived from the dependency graph rather than stored, which is why finishing a
task immediately frees everything waiting on it.

### Persistence and the audit trail

The whole board is written to `frontend/.data/board.json` after every mutation, using
write-then-rename so a crash cannot leave a half-written file. Stopping the process and starting it
again resumes exactly where you left off — including your priority changes and reassignments.

Every change appends an entry naming the actor, the before/after values and the **reasoning** behind
it. Agent entries carry the agent's own stated reason ("Highest-priority item whose 1 dependency is
satisfied"); your entries carry whatever you typed into *Reason for your change*. Both appear in one
trail, so a reviewer can reconstruct why the board looks the way it does.

### Staying in control

Anything you do outranks the plan, and takes effect on the next agent pull:

| Action                          | Effect                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| Set priority (P1–P5)            | Changes what the next agent picks up.                            |
| Drag a card onto another card   | Reorders that lane's queue, so agents pull in your order.         |
| Drag a card to another column   | Moves it to that stage regardless of who holds it.                |
| Reserve for an agent            | Only that agent may claim it; a current holder is released first. |
| Add a work item                 | Goes into the queue alongside the planner's, claimable by anyone. |
| Edit title / details            | Agents pick up the new wording; the item is marked as yours.      |
| Delete                          | Removes it and detaches anything depending on it.                |

Priority outranks queue order: reordering a lane changes what agents pull *within* a priority
band, and a P1 item is still taken before a P3 one sitting above it.

The board is fully operable from the keyboard — tab to a card, space to pick it up, arrows to
move, space to drop.

Each of these bumps the item's `version` — which is exactly what makes an in-flight agent decision
based on the old state lose its compare-and-swap and re-decide against what you just did.

Cards an agent currently holds are not draggable: taking work out from under a working agent is done
deliberately through the detail panel, not by accident.

---

## Project layout

```
frontend/
├── app/
│   ├── api/
│   │   ├── board/          GET    board snapshot (+ housekeeping)
│   │   ├── objectives/     POST   submit a goal and run the planning pass
│   │   ├── run/            POST   start / stop / step the agent pool
│   │   ├── tasks/          GET POST PUT   list, add by hand, reorder queue
│   │   ├── tasks/[taskId]/ PATCH DELETE   move, reprioritise, reassign, edit
│   │   └── audit/          GET    audit trail, optionally per task
│   └── page.tsx            The board UI
├── components/             Board columns, cards, agent roster, audit trail, inspector
└── lib/agentic/
    ├── types.ts            Domain model and the legal transition table
    ├── lifecycle.ts        Pure rules: transitions, claimability, cycles, queue order
    ├── store.ts            File-backed board, write mutex, leases, audit trail
    ├── brain.ts            Claude and local reasoners behind one interface
    ├── planner.ts          Objective → ordered tasks with dependencies
    ├── orchestrator.ts     The autonomous claim → work → release loop
    └── human.ts            Operator controls
```

---

## Tests

```bash
npm test           # unit + integration (Vitest) — 60 tests, no network
npm run verify:claude   # the 2 live API checks (skipped without a key)
npm run e2e        # end-to-end against a real server (Playwright)
npm run lint
npx tsc --noEmit
```

The Vitest suite covers what is easy to get wrong and hard to see: that two agents racing for one
item produce exactly one winner, that a claim decided against stale state is refused, that an
expired lease returns work to the queue, that a dependent task never starts before its upstream
result exists, and that the board resumes correctly from disk.

The agents are driven by a scripted reasoner in tests, so the suite is deterministic and makes no
API calls. The Claude path itself is covered separately against a fake SDK client — the request
this app builds is executed and inspected, so a wrong parameter shape or a mishandled refusal is
caught without spending anything.

---

## Notes and limits

- **Single process.** The write mutex and the agent pool live in one Node process. The store
  revalidates against the file's mtime before every write, so a second process cannot silently
  clobber the board — but running two servers against one data directory is not a supported setup.
- **The run loop is in memory.** A restart resumes the board but leaves the run stopped; press
  **Start run** to continue. This is deliberate: agents should not resume working unattended after a
  crash.
- **`review` waits for a person, not an agent.** Move an item back to **Ready** to hand it to the
  agents again.
- A failing item is retried up to three times, then left in **Failed** for a person to look at.
- **The live Claude path has not been exercised here.** No credentials were available while this
  was built, so everything demonstrated ran on the local reasoner. The request shape, refusal
  handling and response parsing are covered against a fake client and typecheck against the real
  SDK — but `npm run verify:claude` is what actually proves it.
