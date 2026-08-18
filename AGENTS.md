# Agent Instructions

> `CLAUDE.md` is a symlink to this file — Claude Code reads one name, Codex and
> the rest read the other, and there is only ever one set of instructions to
> keep true. Edit this file. If a tool ever rewrites `CLAUDE.md` by replacing
> it rather than writing through it (`bd setup` regenerating the managed blocks
> is the likely culprit), the symlink is gone and the two will start to drift:
> restore it with `ln -sf AGENTS.md CLAUDE.md`.

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Git workflow: main, directly

**Work on `main` and push to `main`.** No feature branch, no pull request, no
waiting to be asked. This holds for `scbrown/creel` and for its state
repository `scbrown/creel-state`.

```bash
just check && just test     # both must pass
git add -A && git commit    # a real message, not "wip"
git push                    # not optional — see below
```

This repository explicitly opts into the **team-maintainer** profile described
in the managed Beads block below, which is what that block means by "only when
the repository explicitly opts in". So: close beads, run the quality gates,
commit, and push as ordinary parts of doing the work.

Three things this does *not* mean:

- **Not "push anything".** `just check` and `just test` gate every push. A red
  gate is a reason to fix or to revert, never a reason to push and mention it.
- **Not "skip the message".** Direct-to-main deletes the pull request, which
  was the place a change got explained. The commit message inherits that job:
  say what changed and why it is right, because the log is now the only review
  anyone gets.
- **Not permanent.** A current instruction to hold off, work on a branch, or
  open a PR overrides this section for as long as it stands.

Work is not finished until `git push` succeeds. Leaving a green, committed
change unpushed strands it on a machine that may not exist tomorrow — which is
the same reason creel pushes its own state to a repository rather than trusting
browser storage.

## Build & Test

No dependencies and no `node_modules` — everything runs on Node's built-ins.

```bash
just serve        # the harness at http://localhost:8420
just check        # parse every JS file, the page's inline scripts, and the
                  # service-worker/asset consistency check
just test         # check, then the fast suites, then real headless Chromium
just test-unit    # skip the browser half
just test-ui      # only the browser half (CHROME_PATH overrides discovery)
```

Both `just check` and `just test` must pass before a push.

## Architecture Overview

A static page that runs agent loops in browser tabs. No server, no build step —
`app/` is the deployable artifact.

| | |
|---|---|
| `app/onepagent.html` | markup and an ordered stack of script tags |
| `app/harness/01..26-*.js` | the harness itself, split out of that page |
| `app/harness.css` | the page's stylesheet |
| `app/creel-*.js` | creel's own layers: self/ui, fleet, locator, device |
| `app/*-backend.js` | in-page MCP servers: quipu, github, state, beads, local, browser, measurement |
| `app/creel-features.js` | feature flags, read before everything else |
| `app/sw.js` | service worker; its precache list is gate-checked |
| `extension/` | the Chrome bridge that reaches cross-origin sites |
| `wasm/` | the quipu knowledge-graph provider, compiled to WASM |
| `tests/` | zero-dependency; `browser.js` drives real Chromium over CDP |
| `tools/` | `bd.js` (tracker CLI), `check-html.js`, `check-shell.js` |

Agents reach every one of those surfaces through MCP tool families — `ui_*`,
`fleet_*`, `github_*`, `state_*`, `quipu_*`, `bd_*`, `browser_*`, `local_*`,
`bench_*`. The authoritative description of the system lives in the quipu graph
itself (`creel-world-model-v4`), mirrored in `docs/hands.md`.

## Conventions & Patterns

- **Classic scripts, shared global scope.** The harness parts are not modules:
  they share one global lexical environment, which is what lets the page's
  inline `onclick=` handlers keep working. **Their load order is semantics** —
  `tools/check-shell.js` fails the gate if they load out of order or if the
  service worker does not know about one.
- **A split IIFE gets an explicit seam.** `creel-self.js` and `creel-fleet.js`
  share `window.CreelSelfInternal` / `window.CreelFleetInternal` with their
  sibling files, rather than leaking their internals globally. Collections on a
  seam are mutated in place, never reassigned, because handlers close over
  them.
- **Every control needs an accessible name.** Agents drive the UI by ARIA role
  and accessible name, like a test author, never by CSS guesswork. An unnamed
  control is unreachable; an ambiguous locator is an error, not a coin flip.
- **Credentials go in, never out.** An agent may be handed a key and asked to
  set it up. No read path exists: snapshots mask them, results report a length.
- **Nothing is durable by default.** Browser storage is evictable. Work leaves
  by `github_push`, `state_push`, or a quipu fact — see the durability rule in
  `DEFAULT_SYSTEM`.
- **Flags, not deletions.** A runtime being off (`app/creel-features.js`) means
  its tools leave the model's list and its loader never runs, while the code
  stays wired so re-enabling is one setting.
- **No dependencies.** Tests included. If something needs a package, it is
  probably the wrong shape for this project.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
