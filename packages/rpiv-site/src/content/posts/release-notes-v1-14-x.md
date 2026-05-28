---
title: "Release notes: v1.14.0"
description: "rpiv-workflow ships as a sibling — typed multi-stage workflows with the new /wf command and four bundled chains. Plus a top-down architecture-review skill, an Ollama search provider, and a four-patch install-hardening tail."
pubDate: 2026-05-28T15:00:00Z
author: juicesharp
tags: ["release", "rpiv-workflow", "rpiv-pi", "rpiv-web-tools", "rpiv-ask-user-question"]
draft: false
---

v1.14.0 is the release that decouples workflow orchestration from
skills. Until now, the pipeline was a set of independent skills that
the developer chained by hand — research, then design, then plan,
then implement. The new `@juicesharp/rpiv-workflow` sibling package
turns that into a typed, audited runtime. rpiv-pi contributes four
bundled workflows that wire the existing skills together, and a new
`architecture-review` skill gives you a top-down structural audit.
Four follow-up patches (1.14.1–1.14.4) harden the install story.

> **Upgrade note.** After updating, run `/rpiv-setup` inside a Pi
> session to install the new `@juicesharp/rpiv-workflow` sibling.
> `pi update` alone won't pick it up — siblings have to be registered
> with Pi explicitly.

## rpiv-workflow: the runtime is its own sibling now

rpiv-workflow is skill-agnostic. It ships zero built-in workflows of
its own. Instead it provides a runtime that chains Pi skills into
typed multi-stage pipelines with JSONL audit state, predicate
routing, and per-stage output validation. Sibling packages contribute
workflows through a `registerBuiltIns` API; rpiv-pi is the first
consumer.

The `/wf` command previews, inspects, and runs workflows. A layered
config loader merges five layers in priority order — built-in → user
packs → user config → project packs → project config — with jiti
TypeScript loading at every layer. The config-vs-pack split matters:
pack files (bundles you install and share) cannot set `default`,
eliminating the "which pack stole the default?" ambiguity when
overlapping packs exist.

The authoring DSL is designed for config-file ergonomics:

```ts
export default defineWorkflow({
  name: "ship",
  stages: [
    produces("plan", { collector: sideEffectOutcome }),
      acts("blueprint", { tool: "/skill:blueprint" }),
    terminal("commit", { tool: "/skill:commit" }),
  ],
});
```

`gate` and `defineRoute` give you conditional branching — route to
repair stages when a review finds blockers, skip validation when a
predicate says the scope is trivial, fan out when a stage needs
parallel work. Every run writes a JSONL audit log to
`.rpiv/workflows/<run-id>.jsonl`.

## Four bundled workflows

rpiv-pi registers four chains that cover the common size-and-risk
spectrum:

| Workflow | Chain | When |
|----------|-------|------|
| `ship` | blueprint → implement → validate → commit | Fast path — no research or review. |
| `build` | research → blueprint → implement → validate → code-review → revise loop → commit | Research-backed with a review loop. |
| `arch` | research → design → plan → implement → validate → code-review → design loop → commit | Design-led for complex changes. |
| `vet` | code-review → blueprint → implement → validate → loop → commit | Examine existing changes for approval, with optional repair. |

Run any of them with `/wf ship`, `/wf build`, `/wf arch`, or
`/wf vet`. `/wf` with no arguments shows every registered workflow
— bundled and user-defined — in a padded columnar list.

## architecture-review skill

The new `architecture-review` skill runs a top-down, layer-by-layer
audit of a software module. It reads every file in scope, applies a
uniform ten-dimension checklist per layer, and triages each candidate
finding through a structured developer checkpoint. The output is a
phased polish plan that the `blueprint` skill can consume per phase.
The skill is language-agnostic — it works on TypeScript, Java, .NET,
Rust, Python, Go, or any other typed module.

It's experimental — under active test. Expect the checklist and the
checkpoint flow to evolve as more codebases go through it.

## Smaller surfaces

The rest of the family moved forward in smaller increments:

- **rpiv-web-tools** learned an Ollama search provider, supporting
  both local instances and the ollama.com cloud endpoint, with a
  configurable base URL and optional API key. The `/web-search-config`
  command was renamed to `/web-tools` to reflect its broader remit.
- **rpiv-ask-user-question** now renders its questionnaire as a
  bottom-anchored overlay, matching the terminal UX pattern that
  Pi's own inline cards use.
- **rpiv-args** fixed `${SKILL_DIR}` to resolve to the skill's own
  directory instead of the extension package root — relative shell
  command paths in skill bodies now land correctly.
- **rpiv-pi `blueprint`** can now run standalone without a research
  artifact, accepting a free-text feature description as input.
  Useful for the `ship` workflow where a full research phase isn't
  warranted.
- **rpiv-pi** removed `outline-test-cases` and `write-test-cases`
  skills. The workflow runtime's typed output contracts and the
  `validate` skill's success-criteria checks cover the same ground
  more tightly.

## A four-patch install-hardening tail

Cutting a brand-new sibling means the install plumbing breaks first.
Four patches landed on the same day:

**v1.14.1.** rpiv-workflow's published tarball was missing
`handle.ts` and `predicates.ts` — both were omitted from the
`package.json` `files` array in the initial release. Fresh installs
failed with `Cannot find module './handle.js'`.

**v1.14.2.** `jiti` and `@juicesharp/rpiv-config` were listed as
`peerDependencies`, but Pi's installer (`pi install`) does not
auto-install peer dependencies into its node_modules tree. Both are
runtime value imports, so the extension crashed on load. Promoted
them to `dependencies` — Pi's resolver now pulls them in
automatically.

**v1.14.3.** Missing sibling extensions are now reported at session
start as a yellow boxed banner listing each absent package and
pointing at `/rpiv-setup`, instead of a single-line warning that
scrolled away with the conversation.

**v1.14.4.** The banner's top border was misaligned — Pi's
`"Warning: "` severity prefix pushed the first row nine columns to
the right relative to the body. A prepended newline fixes the
alignment.

## Anything else?

Every other package in the `@juicesharp/rpiv-*` family bumped to
1.14.0 with no user-visible changes — the standard lockstep ride.
Internally, `rpiv-telemetry` shipped its first MLflow observability
extension (private — not published to npm) with auto-instrumented
Pi lifecycle and sub-agent lineage tracing.

Grab the new version the usual way:

```sh
npm install @juicesharp/rpiv-pi@1.14.0
```

Or let your normal upgrade flow pick it up. The full per-package
changelog lives in each package's `CHANGELOG.md` in the
[monorepo](https://github.com/juicesharp/rpiv-mono).

See you at v1.15.0.
