---
title: "Bake the evidence into the prompt"
description: "Two probing turns at the start of every commit was the wrong default. rpiv-args 1.10 lets Pi skills inline shell output and runtime variables: the same primitive Claude Code ships, ported to Pi."
pubDate: 2026-05-19T17:30:00Z
tags: ["release", "rpiv-args", "skills"]
draft: false
---

Until this release, our `commit` skill opened the same way every
single time. The first two turns were `git status` and `git diff` —
two deterministic shell commands, each routed through the Bash tool
as a decision the model had to make before it could start drafting a
message. Two facts we already knew we wanted, gated behind two tool
calls.

The fix is older than the bug. Claude Code's `SKILL.md` shipped with
`` !`<cmd>` `` preprocessing — shell output gets baked into the skill
body before the model ever sees it. `rpiv-args` 1.10 ports the
primitive to Pi Agent and adds two runtime variables. Same idea, same
syntax, slightly different ergonomics on the edges.

## Don't make the model ask `git status`

The argument is structural, and it isn't new. **Tool calls are
decisions; substituted output is evidence.** Every shell round-trip
the model has to negotiate is a turn that can drift, get dropped, or
collect the wrong flag. Anything we already know we want — the current
branch, the recent commit subjects, the contents of `package.json`
— belongs in the opening prompt, not behind a tool gate.

The `commit` skill rewrite is the easiest demonstration. The actual
frontmatter and Metadata block now read:

````markdown
---
name: commit
shell-timeout: 10
---

## Metadata

```!
node "${SKILL_DIR}/../_shared/git-changes.mjs"
echo "---recent-subjects---"
git log --pretty=%s -n 20 2>/dev/null || true
```
````

One fenced shell block, two commands run sequentially, output baked
in. The model opens with the repo state and twenty recent commit
subjects already in front of it; no probing turns, no skipped diff.
The `_shared/git-changes.mjs` helper exists because the diffstat plus
status output runs longer than a one-liner; the shell-substitution
contract is identical either way.

Fourteen rpiv-pi skills were rewritten to the same shape this release
— see the rpiv-pi 1.10 changelog for the list.

## Substitution is a one-pass preprocessor

Mechanically: `rpiv-args` registers an `input` hook that fires before
Pi's built-in skill expansion. When the body contains any of the new
forms — `` !`<cmd>` ``, a `` ```! `` fenced block, `${SKILL_DIR}`, or
`${SESSION_ID}` — the hook executes the shell commands in
`process.cwd()`, substitutes the output in-place, and emits a
byte-identical `<skill>` wrapper for Pi's downstream `parseSkillBlock`
to parse. Existing argument placeholders (`$1`, `$@`, `${@:N:L}`,
`$ARGUMENTS`) still work and compose with the new forms.

Three rules govern the substitution, and all three matter:

- **One pass, no rescanning.** Command output is inserted as plain
  text. A command that prints `${SESSION_ID}` will not re-expand.
  Claude Code makes the same call, for the same reason — recursive
  substitution is a footgun.
- **Sequential, in source order.** `` !`mkdir x` `` followed by
  `` !`ls x` `` is safe. We don't parallelize.
- **Errors are inlined, not raised.** A timeout becomes
  `[Shell error: timed out after Ns]`. A non-zero exit becomes
  `[Shell error: exit code N]\n<stderr>`. The rest of the body still
  reaches the model — partial evidence is better than none.

Default timeout is 120 seconds. Combined stdout/stderr is capped at
**50 KB / 2000 lines, tail-truncated** so a failure at the end of the
output survives. Per-skill timeout override via `shell-timeout` in
frontmatter (seconds; `0` disables the timer).

## Where we agree with Claude Code, and where we don't

We landed at the same primitive Anthropic landed at, and we should be
honest about that. The syntaxes are byte-identical on purpose — a
skill body using `` !`<cmd>` `` and ` ```! ` blocks moves between Pi
and Claude Code without edits.

Two real differentiators, in either direction:

- **`shell-timeout` frontmatter is ours.** The Claude Code Bash tool
  reference cites a ~120 s timeout and ~30 KB output cap; whether
  inline skill injection inherits those exact defaults isn't
  documented at the skills layer. For single-shell-call skills the
  distinction doesn't matter. For `code-review` scanning a large
  branch diff, the explicit per-skill timeout and the 50 KB / 2000-
  line tail-truncated cap are load-bearing.
- **`disableSkillShellExecution` is theirs.** Claude Code ships a
  managed-settings kill switch that replaces every `` !`<cmd>` `` with
  `[shell command execution disabled by policy]`. We don't have a
  parity knob yet. For an organization shipping Pi to engineers who
  haven't opted into running arbitrary shell at prompt-render time,
  that's the missing piece — it's on the 1.11 list.

Cross-platform is the place the two implementations diverge most. We
pick the shell automatically — `sh -c` on POSIX, `powershell.exe
-Command` on Windows — and lean on two things: PowerShell's name-only
aliases for common POSIX utilities (`ls`, `cat`, `pwd`, `cp`, `mv`,
`rm`, `mkdir` resolve to their cmdlet equivalents) and the fact that
language-ecosystem binaries (`git`, `npm`, `node`, `python`) are
already on PATH. Claude Code asks the skill author to declare
`shell: bash | powershell` in frontmatter. Both choices are
defensible; ours errs toward zero-config, theirs toward explicitness.

For genuinely portable logic — anything more than a `git` call or a
file read — we lean on the fact that **Pi itself runs on Node**. The
TypeScript runtime is a hard prerequisite for the agent, which means
`node` is on PATH on every machine Pi can start on. The rpiv-pi
skills exploit that: nine of the fourteen rewritten skills shell out
to `.mjs` helpers via

```
node "${SKILL_DIR}/../_shared/<helper>.mjs"
```

The `_shared/` directory ships `now.mjs`, `git-context.mjs`,
`git-changes.mjs`, `list-recent.mjs`, and `changelog-bootstrap.mjs` —
each one a small, unit-tested Node script that produces the same
output on POSIX and on PowerShell because there is no shell involved
past the `node` invocation. POSIX-flag drift, cmdlet exit-code
quirks, `Get-ChildItem` vs `ls` — all of it stops at the Node
boundary. Use the shell for one-liners; use a `.mjs` helper for
anything you'd hate to debug twice.

## The footguns we couldn't engineer away

Three failure modes survived the design and the test suite:

- **POSIX flags do not cross to PowerShell.** Aliases match command
  *names*, not flags. `` !`rm -rf x` `` will fail on Windows because
  `Remove-Item` takes `-Recurse -Force`. For destructive operations,
  use external binaries (`git`, `npm`, `node`) or write a portable
  PowerShell block.
- **PowerShell cmdlets return 0 on error by default.** External
  commands propagate exit codes through `$LASTEXITCODE`, so
  `` !`git push` `` reports failure correctly. Cmdlet failures need
  `$ErrorActionPreference = "Stop"` (or `-ErrorAction Stop` per call)
  to surface as non-zero.
- **`steer()` and `followUp()` bypass the `input` hook.** Pi's
  secondary prompt paths skip the event `rpiv-args` attaches to, so
  placeholders are not resolved on those paths. Keep argument-
  substituted skills on the primary prompt path; document it where
  it isn't already obvious.

There is no type validation and no flag parsing — `$1` receives
whatever the user typed, `--env=prod` arrives as a single positional
token. That was true in 1.9 and it's still true in 1.10; the
substitution surface is intentionally thin.

## Install

If you already have `@juicesharp/rpiv-pi` installed, you have nothing
to do — `rpiv-args` is a sibling of the umbrella and gets pulled in
on the next `rpiv-pi` update. For a fresh install of just the
substitution layer:

```
pi install npm:@juicesharp/rpiv-args
```

Skills without placeholders or shell blocks emit byte-identical
output to Pi's built-in expansion, so installing `rpiv-args` over an
existing skill collection is a no-op for skills that don't opt in.

The fourteen rpiv-pi skills rewritten to pre-baked metadata in this
release — `discover`, `research`, `explore`, `design`, `plan`,
`blueprint`, `revise`, `validate`, `changelog`, `commit`,
`create-handoff`, `resume-handoff`, `outline-test-cases`,
`write-test-cases` — are the worked examples. Read their bodies for
what the primitive looks like at the load-bearing end.
