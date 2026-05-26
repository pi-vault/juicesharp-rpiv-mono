# Workflow Authoring Reference

Complete reference for the `@juicesharp/rpiv-workflow` authoring DSL. A workflow is a typed graph: named entry point, a `stages` record, and an `edges` table that maps each stage to another stage name, `"stop"`, or a predicate function.

## Table of Contents

- [defineWorkflow](#defineworkflow)
- [Stage factories](#stage-factories)
  - [produces](#produces)
  - [acts](#acts)
  - [terminal](#terminal)
  - [Script stages](#script-stages)
- [Edge targets](#edge-targets)
- [Conditional routing](#conditional-routing)
  - [gate](#gate)
  - [defineRoute](#defineroute)
  - [Predicate helpers](#predicate-helpers)
- [Outcomes](#outcomes)
  - [Collector catalog](#collector-catalog)
  - [Parser catalog](#parser-catalog)
  - [Custom outcomes](#custom-outcomes)
- [Validators](#validators)
- [Complete example](#complete-example)
- [Validation rules](#validation-rules)

## defineWorkflow

Identity passthrough for type inference. Same idiom as `defineConfig` in Vite/Astro — zero runtime cost.

```typescript
import { defineWorkflow } from "@juicesharp/rpiv-workflow";

export default defineWorkflow({
  name: "my-workflow",       // What users type: /wf my-workflow
  description: "...",        // Optional: shown in /wf preview
  start: "research",         // Entry stage name
  stages: { /* ... */ },     // Stage record (key = stage name)
  edges: { /* ... */ },      // Edge table (key = stage name)
});
```

## Stage factories

Three factories for two stage kinds. Each factory returns a `StageDef` — pass overrides as needed.

### produces

`kind: "produces"`. The skill writes a file the next stage reads. Halts the chain if the path doesn't appear in the transcript. **Requires an `outcome`** — load-time validation rejects a `produces` stage without one.

```typescript
import { produces, typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

// Basic — just declare the outcome
produces({ outcome: myOutcome })

// With output schema (enables gate routing on output.data)
produces({
  outcome: myOutcome,
  outputSchema: typeboxSchema(Type.Object({ blockers_count: Type.Integer() })),
})

// With fanout (one Pi session per unit)
produces({
  outcome: myOutcome,
  fanout: myFanoutFn,
})

// With validation retry
produces({
  outcome: myOutcome,
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  onInvalid: "retry",    // default; "halt" to fail fast
  maxRetries: 3,
})
```

**Stage options:**

| Option | Default | Description |
|--------|---------|-------------|
| `skill` | record key | Pi skill to invoke. Override when stage id ≠ skill name. |
| `outcome` | (required) | `OutputSpec` — how the runtime collects + parses the artifact. |
| `outputSchema` | none | Standard Schema v1 validator for `output.data`. Enables gate routing. |
| `inputSchema` | none | Standard Schema v1 validator for inherited upstream `output.data`. Rejection halts immediately. |
| `onInvalid` | `"retry"` | `"retry"` (re-invoke up to `maxRetries`) or `"halt"` (fail fast). |
| `maxRetries` | — | Max retries on schema rejection. |
| `validateTimeoutMs` | — | Timeout for async schemas. |
| `fanout` | none | `FanoutFn` — decomposes work into N units, one Pi session per unit. |
| `sessionPolicy` | `"fresh"` | `"fresh"` (new session) or `"continue"` (reuse prior session). |

### acts

`kind: "side-effect"`. The skill's side effect IS the work (commit, implement). The next stage inherits the prior artifact list forward.

```typescript
import { acts } from "@juicesharp/rpiv-workflow";

// Basic side-effect
acts()

// With a different skill name
acts({ skill: "implement" })

// With fanout
acts({ fanout: phaseFanout })

// With outcome (e.g., git commit detection)
acts({ outcome: gitCommitOutcome })
```

**Stage options:** Same as `produces` except `outcome` is optional and `kind` is `"side-effect"`.

### terminal

`kind: "side-effect"` with `inheritsArtifacts: false`. A side-effect stage that does NOT inherit the upstream artifact. Its prompt receives `originalInput` (the run's brief) instead of an upstream artifact handle. The rolling primary slot is cleared on success so anything downstream also starts without an inherited handle.

```typescript
import { terminal } from "@juicesharp/rpiv-workflow";

// Final notification stage
terminal()
```

The right answer for a final cleanup / summary / post-run notification stage that shouldn't be coupled to the upstream chain.

### Script stages

Some stages don't need an LLM. The `.script` accessor on each factory runs a pure TS function in place of a Pi skill body. No `/skill:<name>` dispatch, no session.

**`produces.script`** — returns the `Output` envelope's value-channel fields directly:

```typescript
import { produces, fs, type ScriptContext } from "@juicesharp/rpiv-workflow";

const merge = produces.script({
  outputSchema: typeboxSchema(Type.Object({ planPath: Type.String() })),
  run: async (ctx: ScriptContext) => {
    const upstream = ctx.input?.artifacts ?? [];
    const bodies = await Promise.all(
      upstream
        .filter((a) => a.handle.kind === "fs")
        .map((a) => readFile(join(ctx.cwd, (a.handle as { path: string }).path), "utf-8")),
    );
    const planPath = `plans/${Date.now()}.md`;
    await writeFile(join(ctx.cwd, planPath), bodies.join("\n\n---\n\n"));
    return {
      kind: "plan",
      artifacts: [{ handle: fs(planPath), role: "primary" }],
      data: { planPath },
    };
  },
});
```

**`acts.script`** — returns `void`:

```typescript
import { acts, type ScriptContext } from "@juicesharp/rpiv-workflow";

const bumpVersion = acts.script({
  run: async (ctx: ScriptContext) => {
    const path = join(ctx.cwd, "package.json");
    const pkg = JSON.parse(await readFile(path, "utf-8")) as { version: string };
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    pkg.version = `${major}.${minor}.${(patch ?? 0) + 1}`;
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  },
});
```

**`terminal.script`** — like `acts.script` but clears the rolling primary slot:

```typescript
import { terminal, type ScriptContext } from "@juicesharp/rpiv-workflow";

const notifySlack = terminal.script({
  run: async (ctx: ScriptContext) => {
    await fetch(process.env.SLACK_WEBHOOK!, {
      method: "POST",
      body: JSON.stringify({ text: `Run ${ctx.state.originalInput} complete.` }),
    });
  },
});
```

**Constraints on script stages:**
- Cannot declare `skill`, `outcome`, `fanout`, or `sessionPolicy: "continue"` — load-time validation rejects the combination.
- `produces.script` may declare `outputSchema`, `maxRetries`, `onInvalid`.
- `acts.script` / `terminal.script` may declare `inputSchema`.

## Edge targets

Each edge maps a stage name to one of:

```typescript
// 1. Another stage name
edges: { research: "implement" }

// 2. The terminal sentinel
edges: { commit: "stop" }

// 3. A predicate function (via gate or defineRoute)
edges: { "code-review": gate("blockers_count", { revise: gt(0), commit: eq(0) }) }
```

**`STOP`** (or `"stop"`) is the terminal edge sentinel. Every workflow path should eventually reach `"stop"`.

## Conditional routing

### gate

Conditional routing keyed on a numeric field in `output.data`. Branches evaluated against `Number(output.data[field])` in declaration order; first matching predicate wins. Last declared branch is the fallback when no predicate matches.

```typescript
import { gate, gt, eq } from "@juicesharp/rpiv-workflow";

edges: {
  "code-review": gate("blockers_count", {
    revise: gt(0),   // value > 0 → "revise"
    commit: eq(0),    // value = 0 → "commit"
  })
}
// value < 0  → "commit" (no match, falls to last)
// missing/NaN → "commit" (no match, falls to last)
```

### defineRoute

Hand-rolled multi-branch routing. Returns an `EdgeFn` with `.targets` metadata for graph introspection. Auto-marks the route as reading `output.data` — pass `{ readsData: false }` for state-only routes.

```typescript
import { defineRoute } from "@juicesharp/rpiv-workflow";

edges: {
  "decide": defineRoute(
    ["fast-path", "slow-path"],           // All possible returns (required)
    ({ output }) => {
      const data = output?.data as { complexity: string };
      return data?.complexity === "high" ? "slow-path" : "fast-path";
    },
  )
}
```

### Predicate helpers

| Helper | Returns true when |
|--------|-------------------|
| `gt(n)` | value > n |
| `gte(n)` | value >= n |
| `lt(n)` | value < n |
| `lte(n)` | value <= n |
| `eq(n)` | value === n |

## Outcomes

Each `produces` stage wires an `OutputSpec` with a collector (enumerate what the stage produced) and optional parser (interpret into typed data):

```typescript
interface OutputSpec<Snapshot, Kind, Data> {
  collector: ArtifactCollector<Snapshot>;          // ENUMERATE
  parser?:   ArtifactParser<Snapshot, Kind, Data>; // INTERPRET (optional)
}
```

There is no framework default — load-time validation rejects a `produces` stage without an outcome.

### Collector catalog

Grouped by discovery model:

**Scan the agent's text:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `transcriptPathCollector` | `({ pattern: RegExp })` | Scans assistant text for the last regex match; emits one `fs` artifact. |
| `directoryPathCollector` | `({ dir, ext? })` | Wrapper over `transcriptPathCollector` for `<dir>/<file>.<ext>`. |
| `urlCollector` | `({ pattern? })` | Scans for `https?://…`; emits a `url` handle. |

**Observe tool use:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `toolCallCollector` | `({ match, toArtifact })` | Walks every `tool_use` part; emits N artifacts via author's mappers. |

**Diff the filesystem:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `workspaceDiffCollector` | `({ filter? })` | `git status --porcelain` pre-stage, diffs post-stage. One `fs` artifact per touched file. |

**Git:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `gitCommitCollector` | — | Detects new HEAD commit vs. pre-stage snapshot; emits `opaque(sha)`. |

**Composition + empty:**

| Collector | Signature | What it does |
|-----------|-----------|--------------|
| `unionCollectors(...cs)` | — | Run N collectors, concatenate artifacts. Fatal only when every sub-collector fataled. |
| `noopCollector` | — | Always returns `{ kind: "ok", artifacts: [] }`. |

### Parser catalog

| Parser | Output `kind` | Output `data` |
|--------|---------------|---------------|
| `jsonBodyParser` | `"json"` | `JSON.parse` of the primary `fs` artifact's body. |
| `gitCommitParser` | `"git-commit"` | `GitCommitData` (sha, prevSha, subject, filesChanged). |

### Custom outcomes

Use `defineCollector` and `defineParser` to build your own:

```typescript
import { defineCollector, opaque } from "@juicesharp/rpiv-workflow";

export const myCollector = defineCollector((ctx) => {
  // ctx.branch, ctx.cwd, etc.
  const id = parseIdFromBranch(ctx.branch);
  if (!id) return { kind: "fatal", message: "stage did not emit an id" };
  return { kind: "ok", artifacts: [{ handle: opaque(id), role: "primary" }] };
});
```

Handle constructors: `fs(path)`, `url(href)`, `opaque(id)`, `inline(bytes, mime?)`.

Composite outcomes: `sideEffectOutcome` (built from `noopCollector`), `gitCommitOutcome` (built from `gitCommitCollector` + `gitCommitParser`).

## Validators

`inputSchema` and `outputSchema` are Standard Schema v1 values (Zod, Valibot, ArkType, TypeBox via `typeboxSchema`). The runner awaits `~standard.validate` at both seams.

**Default to sync** for pure shape contracts. **Reach for async** when correctness needs I/O (file existence checks, endpoint validation).

```typescript
import { typeboxSchema } from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

outputSchema: typeboxSchema(Type.Object({
  blockers_count: Type.Integer({ minimum: 0 }),
}))
```

A schema rejection on `outputSchema` honours `onInvalid` (`"retry"` by default, `"halt"` to fail fast). A rejection on `inputSchema` halts immediately (no retry — the upstream stage is already frozen).

## Complete example

A full workflow with custom outcomes and conditional routing. This example uses only `@juicesharp/rpiv-workflow` primitives — no external convention packages:

```typescript
import {
  defineWorkflow, produces, acts, gate, gt, eq,
  typeboxSchema, gitCommitOutcome,
  directoryPathCollector, jsonBodyParser, transcriptPathCollector,
  toolCallCollector, fs,
} from "@juicesharp/rpiv-workflow";
import { Type } from "@sinclair/typebox";

// Custom outcome: detect a markdown file the agent writes to a plans directory
const planOutcome = {
  collector: directoryPathCollector({ dir: "plans", ext: "md" }),
  parser: jsonBodyParser,
};

// Custom outcome: detect files the agent writes or edits via tool calls
const writeFileOutcome = {
  collector: toolCallCollector({
    match: (tc) => tc.name === "write" || tc.name === "edit",
    toArtifact: (tc) => ({ handle: fs(String(tc.input.path ?? tc.input.target_file ?? "")) }),
  }),
};

const REVIEW_SCHEMA = typeboxSchema(
  Type.Object({ blockers_count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true }),
);

export default defineWorkflow({
  name: "mid",
  start: "research",
  stages: {
    research:      produces({ outcome: planOutcome }),
    blueprint:     produces({ outcome: planOutcome }),
    implement:     acts(),
    validate:      produces({ outcome: writeFileOutcome }),
    "code-review": produces({
      outcome: writeFileOutcome,
      outputSchema: REVIEW_SCHEMA,
    }),
    revise:        produces({ outcome: writeFileOutcome }),
    "implement-after-revise": acts({ skill: "implement" }),
    commit:        acts({ outcome: gitCommitOutcome }),
  },
  edges: {
    research: "blueprint",
    blueprint: "implement",
    implement: "validate",
    validate: "code-review",
    "code-review": gate("blockers_count", {
      revise: gt(0),
      commit: eq(0),
    }),
    revise: "implement-after-revise",
    "implement-after-revise": "commit",
    commit: "stop",
  },
});
```

## Validation rules

Generated workflows must pass `validateWorkflow()` before writing. The validator checks:

- `start` references a declared stage
- Every edge key exists in `stages`
- Every edge target exists in `stages` or is `"stop"`
- Stage kinds are valid (`"produces"` or `"side-effect"`)
- `produces` stages have an `outcome`
- `gate` / data-reading `defineRoute` source stages have `outputSchema`
- Fanout is incompatible with `sessionPolicy: "continue"`
- Script stages cannot declare `skill`, `outcome`, `fanout`, or `sessionPolicy: "continue"`

> **Important:** The `/wf` command blocks execution on any `severity: "error"` issue. Always validate before writing.
