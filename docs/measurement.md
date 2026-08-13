# The measurement: does free grounding rescue a cheap model?

*Status: first arm (grounded-cheap) run and recorded — 2026-08-14. Results
table filled; verdict pending the ungrounded and frontier arms.*

VISION v2 bets that **small, cheap models become viable agents when grounding
is local and free**: quipu-in-the-page gives every agent sub-millisecond,
zero-token access to what you already know, so a cheap model that would waste
its budget *reconstructing context* can instead *use* it. This is the
experiment that turns that bet into a number.

The harness is the in-page **`bench`** MCP server (`app/measurement-backend.js`)
plus the fleet. Only the LLM calls cost anything; seeding, grading, and the
cost math are free and verified headlessly.

## Design

Three arms, the **same task suite**, one variable between the two cheap arms —
whether the graph is seeded:

| arm | model | graph | role |
|---|---|---|---|
| `ungrounded-cheap` | `deepseek-v4-flash` | empty | baseline |
| `grounded-cheap` | `deepseek-v4-flash` | seeded | treatment |
| `frontier` | `deepseek-v4-pro` | empty | ceiling |

The suite (`bench_info` / `bench_tasks`) is a synthetic service fleet
("Kestrel") whose entity names exist **only** in the seed — the dependency
graph, two incidents, a ratified decision, team ownership. So the tasks
("which deployment caused incident K17?", "if ledger changes, what's
impacted?", "does billing→auth sync violate a decision?") are answerable in
one `quipu_query` when grounded, and pure guesswork when not. 11 tasks: 10
objectively gradeable (set / exact / contains / numeric), 1 judged.

## Metrics

- **Success rate** = tasks passed ÷ tasks attempted.
- **Cost per *completed* task** = `(in_tokens·in_price + out_tokens·out_price) ÷ tasks_passed`.
  "Per completed" is the honest denominator — an arm that fails half its tasks
  isn't cheap. Prices (USD / 1M tokens, editable in `PRICES`): flash
  0.14 / 0.28, pro 0.435 / 0.87.

The bet is **confirmed** if grounded-cheap's cost-per-completed is far below
frontier's while its success rate stays close. If grounded ≈ ungrounded, the
bet is **wrong** — a real and valuable outcome.

## Run procedure

For each arm, in a creel tab (the operator agent can drive this end to end):

1. **Set the arm.** `ui_set_model` to the arm's model.
2. **Set grounding.**
   - grounded-cheap → `bench_seed` (loads the Kestrel graph into the shared store).
   - ungrounded / frontier → run on a **fresh browser profile** (empty OPFS) so
     no stray facts leak in, and do **not** seed. (Clearing site data resets OPFS.)
3. **Run the burst.** `bench_tasks` → `fleet_enqueue` those prompts →
   `fleet_spawn_workers`. Each worker answers one task through creel's real
   agent loop and `fleet_report`s its answer. (Grounded workers should
   `quipu_cord`/`quipu_query` the graph; that's the whole point.)
4. **Grade + record.** For each task: `bench_grade {taskId, answer}` →
   `bench_record {arm, model, taskId, pass, inputTokens, outputTokens}`. Token
   counts are **captured automatically**: `fleet_report` records the delta of
   the harness's cumulative input/output counters between claim and report, and
   `fleet_synthesize` returns `inputTokens`/`outputTokens` per task — read them
   straight off the synthesized payload rather than eyeballing provider usage.
   The judged task (t11) needs a human or an LLM-judge pass against its rubric.
5. Repeat for all three arms.

> **⚠ Keep the tab visible for the whole burst.** On Android (and any browser
> that suspends background tabs), navigating away kills the worker tabs'
> network/timers mid-task: leases wedge with no progress, no episodes, and no
> response to messages (observed live 2026-08-14: 4 leases wedged 16+ min in
> wave 1, then all 3 wave-2 workers wedged the same way — including two *idle*
> workers that stopped claiming queued leases, and a wedged worker ignoring a
> direct `fleet_send` nudge). Recovery = `fleet_abort` the worker tabs, abort
> the ghost leases, re-enqueue the tasks, spawn fresh workers. Strong
> evidence for the suspend-on-hide theory: with the tab kept visible, the same
> tasks completed in ~2 min. A stale-lease auto-requeue timeout is a proposed
> fix (bead `creel-vkh`).

Then **`bench_report`** emits the table below and the headline verdict.

## Results

Run 1: **grounded-cheap** (`deepseek-v4-flash`, graph seeded), 2026-08-14.
Fleet burst of 11 tasks; 4 leases wedged by background-tab suspension (see ⚠
note above) and were re-run by fresh workers with the tab kept visible — every
task then completed and passed.

| arm | model | tasks | passed | success rate | total tokens | cost (USD) | cost / completed (USD) |
|---|---|---|---|---|---|---|---|
| grounded-cheap | deepseek-v4-flash | 11 | 11 | 100% | 3,629,541 | $0.50955 | $0.04632 |
| ungrounded-cheap | deepseek-v4-flash | | | | | | |
| frontier | deepseek-v4-pro | | | | | | |

All 11 tasks graded objective-pass (10 objective keys + the t11 rubric judged
pass on K17/D9/ledger). Two grading notes: (1) the `exact` grader originally
preserved hyphens while collapsing all other punctuation, so the t6 answer
"Core team" (correct fact, paraphrased entity label) failed against key
`Core-team`; `norm()` now maps `-` → space, treating the two as equivalent —
re-graded pass, applied uniformly to all arms. (2) t4's answer
"auth, billing, search, gateway" passed as an unordered set.
**Verdict:** _______________ (pending other arms; see "Fold back").

## Honest limits

- **Costs real tokens** — this is the one creel feature that can't be verified
  headlessly; it needs the operator's key and a deliberate run.
- **Token deltas are approximate.** The claim-time baseline snapshot can race
  the conversation-state flush and capture a stale (0) input/output counter
  (seen on 4 of 9 grounded tasks), inflating the input delta for that task.
  Cross-check totals against the provider's usage page; a flush-before-snapshot
  is the fix (bead `creel-vkh`).
- **Small N is directional, not publishable.** 11 tasks tells you whether to
  keep betting on the architecture, not a paper.
- **Grading**: objective keys where possible; the one judged task adds noise.
- **Confounds**: same tasks, order, and temperature across arms; the *only*
  difference between the cheap arms is the seeded graph.

## Fold back

Once run, copy the verdict line into `docs/VISION.md` §"The core bet", turning
the vision's central claim from hypothesis to cited result.
