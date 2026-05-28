---
title: "Run a workflow"
description: "Hand the skill chain to /wf. The four bundled workflows, when to use each, and when hand-driving still wins."
section: "guides"
order: 5
---

The chain is the same whether you invoke skills yourself or hand them to `/wf`. The runner dispatches `/skill:<name>` exactly the way you would, writes the same artifacts under `.rpiv/artifacts/`, and obeys the same fresh-session boundaries. What it adds is the wiring around the chain: typed routing between stages, per-stage output validation with retry, and an audited JSONL trail every run leaves behind.

Two reasons to reach for it. The chain is a graph, not a line, and the runner is what makes the branches real — `code-review` returns blockers, the runner counts them, and the next stage is `revise` or `commit` accordingly. The trail is the other reason: every run lands on disk as JSONL, so a teammate, a stronger model, or `runWorkflow` from cron can replay or resume from any stage.

`/wf` lives in `@juicesharp/rpiv-workflow`, installed alongside `rpiv-pi`. If `/rpiv-setup` ran cleanly, it's already there.

## Three commands

```
/wf                        Preview every loaded workflow.
/wf <name>                 Preview one workflow's stage graph.
/wf <name> <input>         Run a workflow with <input> piped to the start stage.
```

Preview first. The graph view shows every stage, its skill, the edges out (linear, `stop`, or a predicate), and where the routing branches land. Run when the graph matches what you'd hand-drive.

## The four bundled workflows

`rpiv-pi` ships four workflows. Each maps to a posture from [Pick your path](/docs/guides/pick-a-path), not 1:1, but close enough to pick by name:

### `/wf ship <input>`

Fast path with no research and no review. `blueprint → implement → validate → commit`. Best when the change is small-to-midsize and the approach is already obvious — the FRD-or-equivalent enumerates the work, there's no need to pull adjacent code into context, and you don't expect `code-review` to surface anything you wouldn't catch yourself. `implement` fans out into one Pi session per `## Phase N:` heading the inherited plan declares (cap 32 phases).

### `/wf build <input>`

Research-backed feature work with a review loop. `research → blueprint → implement → validate → code-review → revise → implement → loop ... → commit`. The midsize recipe from `pick-a-path`, with the loop wired in: `code-review` declares an `outputSchema` of `{ blockers_count: integer }`, the edge is `gate("blockers_count", { revise: gt(0), commit: eq(0) })`, and `revise` re-enters `implement` rather than `code-review`. The `revise` stage reads both the latest plan and the latest review (via `reads: ["plans", "reviews"]`) so the skill receives both artifacts as labelled flags. Iteration is bounded by the runner's `maxBackwardJumps` guard (default 2 → at most 3 review iterations).

### `/wf arch <input>`

Design-led pipeline for complex changes. `research → design → plan → implement → validate → code-review → design → loop ... → commit`. The large recipe without a `revise` stage at all — when `code-review` reports blockers, the loop returns to `design` directly and the full design/plan/implement/validate/review cycle runs again. Use when the architecture itself is what's wrong and the plan needs to be rebuilt, not patched. Same `maxBackwardJumps` bound applies.

### `/wf vet`

Examine an existing diff for approval, optionally repair it. `code-review → (blueprint → implement → validate → back to code-review) → commit`. Routing here doesn't use `gate` — `code-review` emits a string `status` of `"approved" | "needs_changes" | "requesting_changes"` and a `defineRoute` predicate sends `"approved"` to `commit` and the two not-approved statuses to `blueprint`. Orthogonal to the scope axis: point it at your own staged work or a teammate's PR branch when you want a structured second pass with an optional fix cycle.

## What `/wf` adds over hand-driving

**Conditional routing with a bounded loop.** The hand-driven chain treats `code-review → commit` as the default and you eyeball the review to decide whether to `revise`. The workflow makes the routing explicit — a `gate(field, branches)` over `output.data`, or a `defineRoute(targets, fn)` for non-numeric discriminators (the path `vet` takes for its string `status`). Backward edges are first-class: a `revise → implement` jump or a `code-review → design` jump is just another edge target, with the runner counting backward jumps and halting at `maxBackwardJumps` (default 2) so a stuck loop can't burn through your tokens forever.

**An audited trail.** Every run writes one JSONL file under `<cwd>/.rpiv/workflows/<run-id>.jsonl`. The first line is a `WorkflowHeader` carrying the run id, workflow name, original input, timestamp, and trigger (`command`, `programmatic`, or `external` with a source string for webhooks and cron). Subsequent lines are one `WorkflowStage` row per executed stage plus routing-decision rows. `listRuns(cwd)` enumerates headers cheaply (first-line reads only); `readLastStage`, `readAllStages`, and `listArtifacts` open a specific run for inspection.

**Programmatic entry points.** `/wf` is one of three doors. `runWorkflow(ctx, { workflow, input, host, trigger?, lifecycle? })` lets a sibling extension, a cron job, or a webhook handler kick off the same chain — the JSONL header records which it was via `trigger`, so post-hoc readers know whether a run came from your terminal or a deploy hook. The return envelope (`{ runId, stagesCompleted, success, lastArtifact?, error? }`) is what calling code branches on.

## What the runtime lets you express

The runner is the visible surface, but the foundation is a typed graph runtime. Four capabilities the chain wouldn't have on its own:

### Mix skills with TypeScript stages

Not every stage needs an LLM. Merging two upstream artifacts, bumping a version field, fanning a payload to Slack — these are pure functions. Each factory exposes a `.script` accessor that runs a TypeScript body in place of a Pi skill, with no `/skill:<name>` dispatch and no session:

```ts
import { acts, type ScriptContext } from "@juicesharp/rpiv-workflow";

const bumpVersion = acts.script({
  run: async (ctx: ScriptContext) => {
    const pkg = JSON.parse(await readFile("package.json", "utf-8"));
    pkg.version = bump(pkg.version);
    await writeFile("package.json", JSON.stringify(pkg, null, 2));
  },
});
```

Same lifecycle, same JSONL audit, same place in the graph as a skill stage. `produces.script` returns an `Output` envelope downstream stages narrow on; `acts.script` and `terminal.script` return `void` and stand in for side effects.

### Typed contracts at the seams

`inputSchema` and `outputSchema` are [Standard Schema v1](https://standardschema.dev) values — Zod, Valibot, ArkType, or TypeBox via the bundled `typeboxSchema` adapter. Sync resolves in a microtask and gives the skill precise retry diagnostics on shape drift. Async lets correctness reach into I/O — "the path the skill emitted must actually exist on disk," "the spec must validate against a live endpoint" — bounded by a per-stage `validateTimeoutMs` (default 5 min, clamped to [1 s, 30 min]). A rejection on `outputSchema` honours `onInvalid` (default `"retry"` with `maxRetries` defaulting to 1 — so two attempts total — or `"halt"` to fail fast); a rejection on `inputSchema` is a hard contract that halts immediately, no retry path.

### Pluggable artifact resolution

A stage's `outcome` tells the runtime what the skill produced and how to read it: a collector enumerates the artifacts, an optional parser interprets them into typed `output.data`. Bundled collectors cover the common discovery models — `transcriptPathCollector` scans the agent's text, `toolCallCollector` walks every `tool_use` part, `workspaceDiffCollector` diffs the working tree, `gitCommitCollector` detects a new HEAD — and `unionCollectors` composes them when a stage's deliverable lives in more than one place at once. Anything that doesn't fit drops in via `defineCollector` + `defineParser`: the runner doesn't care whether your skill writes markdown, emits JSON to stdout, or stamps a Linear ticket id into a branch name.

### Multi-artifact inputs and outputs

The default prompt to a stage carries one positional arg — the upstream rolling primary artifact. When a stage needs more (the canonical case: a "revise plan based on review" step that consumes both the plan and the review), it declares `reads:` against names in the named-publish registry:

```ts
revise: produces({ outcome: planOutcome, reads: ["plans", "reviews"] })
```

The runner replaces the default prompt with a labelled-flag form — `/skill:revise --plans <plan-path> --reviews <review-path>` — and repeats flags when a slot holds more than one artifact (`--plans <a> --plans <b>`), matching how `argparse` / `clap` / shell utilities collect repeated flags. The registry persists every `produces` stage's `Output` across the run, so two stages can converge on the same name (both publish the canonical plan), iteration history survives backward-jump loops, and the load-time validator catches `reads:` typos before the workflow ever runs.

## When hand-driving still wins

Pick the runner when the shape of the work matches one of the four bundled chains and you've walked that chain enough times to trust it. Otherwise stay in the loop:

- **First pass on an unfamiliar codebase.** The artifact-by-artifact pause is where you learn what the model is doing. The runner collapses that into one command — useful later, not now.
- **Exploratory work where you'll pivot mid-chain.** If you'll likely abandon `blueprint`'s output to re-run `discover` with a different framing, the runner's straight-through execution costs you tokens you didn't need to spend.
- **Plan-review with a stronger model.** The `pick-a-path` note about handing a `plan` artifact to a smarter model for a second-opinion review is still the right move on architecturally load-bearing work. `/wf arch` doesn't disable that — you can still stop mid-run, hand the plan out, and resume — but the pause is easier to take when you're already hand-driving.

## Author your own workflow

The four bundled workflows are skill-agnostic in shape — the runner doesn't know `research` or `commit` ship from `rpiv-pi`. Drop a TypeScript file under `.rpiv-workflow/workflows.config.ts` in your project (or `~/.config/rpiv-workflow/workflows.config.ts` for a user-level default) and chain your own skills:

```ts
import { defineWorkflow, produces, acts, gate, gt, eq } from "@juicesharp/rpiv-workflow";
// myPlanOutcome / myReviewOutcome are your OutputSpec values
// (collector + optional parser). produces stages require one — the
// load-time validator rejects a produces stage without an outcome.

export default defineWorkflow({
  name: "review-and-ship",
  start: "plan",
  stages: {
    plan: produces({ outcome: myPlanOutcome }),
    implement: acts(),
    "code-review": produces({ outcome: myReviewOutcome, outputSchema: REVIEW_SCHEMA }),
    revise: produces({ outcome: myPlanOutcome, reads: ["plan", "code-review"] }),
    commit: acts(),
  },
  edges: {
    plan: "implement",
    implement: "code-review",
    "code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }),
    revise: "implement",
    commit: "stop",
  },
});
```

Two file roles per layer. **Config files** (`workflows.config.ts`) are the one TypeScript file you hand-edit per project or per user, and the only place that can set `default` — the workflow `/wf <input>` runs without a name. **Pack files** (`workflows/*.ts`) are installable bundles: drop them in, get new workflows, no risk of overwriting your default. This is what makes shared workflow packs safe.

The full DSL — every stage factory, the bundled outcome catalog, conditional routing, script stages without a Pi session, lifecycle observers, the programmatic runner — lives next to the runtime: see the [rpiv-workflow README](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-workflow/README.md) and the [authoring reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-workflow/docs/workflow-authoring.md).

## Next steps

- [Pick your path](/docs/guides/pick-a-path): the scope map the bundled workflows mirror
- [Walk the chain](/docs/guides/first-skill-chain): the same chain hand-driven, one artifact at a time
- [Reset between skills](/docs/guides/reset-between-skills): the fresh-context rule the runner already enforces
