---
title: "Release notes: v1.15.0"
description: "rpiv-web-tools learns to read GitHub repositories — opt-in by default. Plus a SearchProvider / FetchProvider role split, a fetchViaGenericHtml DRY refactor, and a TypeBox-validated single config reader. One feature, three architectural cleanups."
pubDate: 2026-05-28T16:30:00Z
author: juicesharp
tags: ["release", "rpiv-web-tools", "rpiv-config"]
draft: true
---

v1.15.0 is a single-package release. `rpiv-web-tools` learns a new
trick — `web_fetch` can route github.com URLs through `gh` / `git`
and return file trees, READMEs, and individual file contents instead
of the rendered HTML page. The feature was originally landed by
[@tcuthbert in PR #45](https://github.com/juicesharp/rpiv-mono/pull/45)
as an always-on intercept. This release ships the same capability
through a generalized `UrlInterceptor` chain, walks the default back
to **off**, and bundles three internal cleanups that fall out of
treating GitHub honestly as a URL specialist instead of a search
provider.

> **Upgrade note.** Existing users see **zero behavior change** on
> upgrade — github.com URLs continue to be fetched by the active
> search provider's normal path. The interceptor is opt-in. Add
> `"interceptors": { "github": true }` to
> `~/.config/rpiv-web-tools/config.json` (or pass
> `{ interceptors: { github: true } }` to `registerWebTools` from a
> consumer extension) to turn it on. Restart your Pi session after
> editing the config.

## GitHub URLs, finally readable

A github.com URL in a `web_fetch` call used to come back as the
HTML-stripped chrome of the rendered page — useful for the
description and the readme block, useless for the code itself. The
interceptor parses the URL into `owner` / `repo` / `ref` / `path`,
probes for the `gh` CLI (falling back to plain `git` with a one-time
hint about installing `gh` for private-repo support), shallow-clones
the repo into `$TMPDIR/pi-github-repos`, and returns whatever the URL
actually pointed at — a directory listing for `/tree/main/src`, the
file content for `/blob/main/src/index.ts`, or a tree + README for the
repo root.

```jsonc
// ~/.config/rpiv-web-tools/config.json
{
  "provider": "brave",
  "apiKeys": { "brave": "..." },
  "interceptors": { "github": true }
}
```

That's the whole opt-in. Power users can replace the boolean with an
object to tune the thresholds:

```jsonc
{
  "interceptors": {
    "github": {
      "maxRepoSizeMB": 1000,
      "cloneTimeoutSeconds": 90,
      "clonePath": "/Users/me/.cache/pi-github-repos"
    }
  }
}
```

Object form implies opt-in (`enabled: true` is the default inside the
object). Repos above `maxRepoSizeMB` skip the shallow clone and fall
back to a `gh api` JSON view — tree listing plus README, or a single
file's content. SHA-pinned URLs always use the API path because
shallow-clone-by-SHA isn't supported by Git.

A few categories of github.com URL deliberately don't trigger the
interceptor — `/issues`, `/pulls`, `/discussions`, `/releases`,
`/wiki`, `/actions`, `/settings`, `/security`, and roughly twenty
other UI-only paths fall through to the active provider's normal
fetch. The interceptor handles code; the rest is a normal web page.

`/web-tools --show` reports the current interceptor state at the
bottom of its output:

```
URL interceptors:
  github: enabled (GITHUB_TOKEN: ghp_***xyz, maxRepoSizeMB: 350, clonePath: /var/folders/.../pi-github-repos)
```

When disabled, the same block shows the enable hint with a
copy-pasteable JSON snippet.

## Why default-off

The PR title that brought GitHub support in was "always-on web_fetch
intercept" — and that framing made sense in isolation. Walking it
back required deciding whose behavior we'd rather preserve. Three
audiences had a stake:

1. **Existing rpiv-web-tools users on v1.14.7.** Already on npm, doing
   the simple thing — Brave or Tavily search, HTML scrape on fetch.
   `gh` may not be installed. `/tmp` may be on a tiny ramdisk. A
   surprise clone on the first github.com `web_fetch` is at best a
   slower response, at worst a CI failure.
2. **The web-research agent inside `rpiv-pi`.** Wants every github.com
   URL routed through the interceptor — that's the entire reason this
   feature exists.
3. **Extension authors composing rpiv-web-tools into their own
   surfaces.** Want to decide for their users without the user having
   to know.

The two-tier resolution model gives each audience its own dial. End
users own the config knob; consumers pass `interceptors.github: true`
at registration time as a default for their own surface; explicit
`false` at the user tier always wins. Default off respects the
existing-user case; consumer-side `true` covers the agent case
without requiring every research-agent user to edit JSON before they
can use the feature.

## Three architectural cleanups

The interceptor work pulled the rest of the package into a sharper
shape. Brief tour for anyone composing against the SearchProvider
contract directly:

**SearchProvider / FetchProvider role split.** The omnibus
`SearchProvider` interface mandated both `search()` and `fetch()`.
In practice the eight providers fell into three categories: five with
native fetch endpoints (Tavily, Exa, Jina, Firecrawl, Ollama), three
search-only (Brave, Serper, SearXNG), and one URL specialist
(GitHub — neither search nor fetch in the conventional sense). The
new interfaces match the shape of the world:

```ts
interface SearchProvider { search(...): Promise<SearchResponse> }
interface FetchProvider  { fetch(...):  Promise<FetchResponse>  }
type     FullProvider  = SearchProvider & FetchProvider
```

`ProviderMeta.roles: ReadonlyArray<"search" | "fetch">` makes the
capability matrix visible at the type level. `web_fetch` dispatches
three-way: URL interceptor chain → provider's native fetch when
`"fetch" in provider` → shared HTML fallback.

**`fetchViaGenericHtml` helper.** The four-step quartet —
`fetchUrlOrThrow → assertTextContentType → extractBodyAsText →
FetchResponse envelope` — was copy-pasted across Brave, Serper, and
SearXNG. It existed because the old `SearchProvider` interface
required a `fetch()` method, not because those vendors had a fetch
endpoint to call. One named export in `providers/fetch-helpers.ts`
now serves as the orchestrator's fallback branch, and the three
search-only providers shed their `fetch()` methods entirely.

**TypeBox-validated single config reader.** The Phase 1 work moved
GitHub interceptor settings off a parallel `~/.pi/web-search.json`
file (introduced briefly in PR #45) into the canonical
`~/.config/rpiv-web-tools/config.json` under a new `interceptors`
key. Phase 4 formalized the consolidation: a `WebToolsConfigSchema`
TypeBox definition covers every released field (`provider`,
`apiKeys`, `baseUrls`, `apiKey` legacy, `guidance`, `interceptors`),
and `providers/config.ts` is the single reader-writer everywhere in
the package. `rpiv-config` gained a sibling-agnostic
`GuidanceFieldsSchema` export — the TypeBox form of the
`GuidanceFields` interface it already owned — so siblings composing
larger validated configs don't have to redeclare the leaf shape.

## TypeScript breakage worth flagging

Two consumer-side TypeScript errors land with the role split:

- Code that imported `SearchProvider` and called `.fetch()` on it
  will fail to compile. Migrate the type annotation to `FullProvider`
  for Tavily/Exa/Jina/Firecrawl/Ollama users, or narrow generic code
  with `"fetch" in provider`.
- Code that called `new BraveProvider(key).fetch(...)`,
  `new SerperProvider(key).fetch(...)`, or
  `new SearxngProvider(...).fetch(...)` directly will fail to
  compile. Use `fetchViaGenericHtml(url, raw, signal)` from
  `providers/fetch-helpers.ts` — the orchestrator now reaches it the
  same way.

No config migration required. Every released config key on disk
behaves identically.

## Thanks @tcuthbert

PR #45 did the foundational work — the URL parsing, the `gh`/`git`
fallback ladder, the size-threshold escape valve, the 1169-line test
suite. The URL-specialist *concept* came in with that PR and is now
the shape every future host-targeted handler will use:
[#30's multi-extension story](https://github.com/juicesharp/rpiv-mono/issues/30)
is the most direct beneficiary, and npm-package, PyPI-package, and
MDN-shaped specialists become roughly "implement `UrlInterceptor`,
register in `INTERCEPTORS`, done" rather than "add another branch in
`web-tools.ts`."

## Anything else?

Every other package in the `@juicesharp/rpiv-*` family bumped to
1.15.0 with no user-visible changes — the standard lockstep ride.
The only other touched file outside `rpiv-web-tools` is the new
`GuidanceFieldsSchema` export in `rpiv-config`.

Grab the new version the usual way:

```sh
npm install @juicesharp/rpiv-web-tools@1.15.0
```

Or let your normal upgrade flow pick it up. The full per-package
changelog lives in each package's `CHANGELOG.md` in the
[monorepo](https://github.com/juicesharp/rpiv-mono).

See you at v1.16.0.
