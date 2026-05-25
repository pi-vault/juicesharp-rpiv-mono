# @juicesharp/rpiv-workflow

## [Unreleased]

### Breaking — Pi types removed from public surface
- The public type surface no longer names any `@earendil-works/pi-coding-agent`
  type. Three workflow-owned host ports replace them in
  signatures: `WorkflowHost` (default export + continue-policy sender),
  `WorkflowCommandHost` (`runWorkflow`'s ctx + `RunContext.pi` /
  `RunWorkflowOptions.pi`), and `WorkflowSessionHost` (the replacement
  ctx delivered to `newSession`'s `withSession` callback).
- Pi's `ExtensionAPI` / `ExtensionCommandContext` structurally satisfy
  the new ports, so embedders pass their existing Pi handles to
  `runWorkflow` without any source change. A compile-time tripwire
  (`host.test.ts`) fails CI if Pi's API ever drifts below the port shape.
- `RunContext` is no longer exported from the barrel — it was internal
  to the runner and had no external consumers.
- `BaselineCtx.pi` / `ExtractCtx.pi` removed. The field was dead today
  (the runner never populated `ExtractCtx.pi`, and no bundled outcome
  read `BaselineCtx.pi`). Custom outcomes that need agent-level access
  should accept a narrow capability injection at construction time
  rather than reaching into the runtime ctx.

### Breaking — on-disk JSONL header
- `WorkflowHeader.preset` renamed to `workflow`. Audit files written by
  prior versions have a header row that no longer matches the current
  shape. Audit files are debug artifacts (per `state.ts`); no migration
  is provided. (L2-08 / T5-vocabulary-drift)

### Added
- Initial release. Extracted from `@juicesharp/rpiv-pi` as a standalone Pi
  extension. The package is **skill-agnostic** — install it on its own
  and write workflows over your own `~/.pi/agent/skills/`, or pair with
  `@juicesharp/rpiv-pi` to use the bundled `mid`, `large`, `small`
  workflows over rpiv-pi's skills.
- `/wf` slash command — preview workflows (no-args), preview one workflow
  (`/wf <name>`), or run one (`/wf <name> <input>`).
- Layered jiti loader with canonical + drop-in convention:
  `~/.config/rpiv-workflow/workflows.config.ts` + `workflows/*.ts`;
  `<cwd>/.rpiv-workflow/workflows.config.ts` + `workflows/*.ts`.
- Programmatic API: `registerBuiltIns(workflows)` for sibling packages
  that want to contribute workflows at load time.
