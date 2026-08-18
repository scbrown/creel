# creel's interface rules

*2026-08-18. Status: adopted — tokens live in `app/harness.css`, the shell uses
them. The naming rules are enforced by `tests/test-ui-browser.js` and
`tests/test-ui-surfaces.js`; the token rules by review, not yet by a linter.*

creel's interface grew by accretion. Inline styles everywhere, ad-hoc hex
colours beside CSS variables, a dozen font sizes, arbitrary paddings — so every
new control was designed from scratch and looked like it. That is the actual
cause of the busyness people notice: **with no rules, more capability always
means more noise.** These are the rules.

## The first rule: capability is not a button

creel does a great many things. It does not follow that a great many of them
belong on screen. The left panel once stacked eleven sections and the header
sixteen controls, which is what "show everything we can do" looks like — the
union of every feature the project has ever grown, competing for one operator's
attention.

Ask of any control: **does someone use this in most sessions?** If not, it goes
behind disclosure. Not deleted — creel's whole shape is flags and reveals
rather than deletions — but not in the default surface either.

Two things override this:

- **An active mode is always visible.** Hiding a mode that is ON is worse than
  showing a button that is off. Plan mode, Ralph mode, unpushed state, a live
  fleet: if it changes what the next action will do, it stays on screen.
- **A destructive action is never more prominent than its constructive
  neighbour.** "Clear" sat at full size in the header while "new thread" was
  three levels deep in a collapsible panel. That is backwards, and it is how
  people lose work.

## Tokens

Everything below is a CSS custom property in `app/harness.css`. Nothing should
introduce a value outside these scales; if something needs a size that is not
here, the answer is almost always the nearest step.

### Colour — Dracula, unmodified

The official palette. The value of a known palette is that it is *known*: a
hand-tuned near-miss reads as a mistake rather than as a choice.

| token | value | means |
|---|---|---|
| `--bg-root` | `#21222c` | the page floor |
| `--bg-panel` | `#282a36` | panels, chrome |
| `--bg-card` | `#343746` | raised surfaces |
| `--bg-hover` | `#44475a` | hover, selection |
| `--text-primary` | `#f8f8f2` | what you read |
| `--text-secondary` | `#a4accd` | supporting copy |
| `--text-dim` | `#6272a4` | metadata; the dimmest legible tone |

Depth is **elevation, not outlines**: a raised surface changes background, it
does not acquire another border. Four greys is the whole vocabulary.

Accents carry fixed meanings. An accent used decoratively costs the meaning
everywhere else:

| token | value | means |
|---|---|---|
| `--accent-orange` | `#ffb86c` | agent action (the agent-hands flash ring) |
| `--accent-cyan` | `#8be9fd` | human action (the human flash ring) |
| `--accent-green` | `#50fa7b` | healthy, connected, saved |
| `--accent-red` | `#ff5555` | refusal, danger, destructive |
| `--accent-purple` | `#bd93f9` | the interactive accent — links, focus, primary |
| `--accent-yellow` | `#f1fa8c` | attention without alarm — unpushed, stale |

The light theme keeps its own accent values, tuned for contrast on white. The
scales below are theme-independent: a spacing step is not a colour.

### Spacing — `--space-1` … `--space-6`

`2 · 4 · 6 · 10 · 14 · 20`. Sub-linear at the bottom, because the difference
between 2px and 4px is legible where 20px and 24px is not.

### Type — `--text-xs` … `--text-lg`

`10 · 11 · 12 · 14`. Four sizes is enough for a dense tool. `--text-sm` (11px)
is the workhorse: controls and labels. `--text-lg` (14px) is reserved for the
transcript, which is the only thing here anyone reads at length.

Weight before size, and size before colour, for emphasis. Reach for a
different colour last — see the accent meanings above.

### Radii — `--radius-sm` … `--radius-lg`

`4 · 6 · 10`. Small for controls, medium for panels and menus, large for
floating things that need to read as detached.

## Naming, because agents drive this too

Every control needs an accessible name, and the name is the API: agents locate
by ARIA role and accessible name, exactly as a test author does. An unnamed
control is not merely inconvenient, it is *unreachable* — `tests/test-ui-browser.js`
fails the build over it.

So: an icon-only button takes an `aria-label` that says what it does, not what
it looks like. A `<select>` is named for the choice it makes, never after its
current option. And a control that is hidden by disclosure must be genuinely
hidden — the `hidden` attribute, not `display:none` alone — so the interface an
agent describes is the interface the operator is looking at.

Four corollaries, each of which cost a real bug before it became a rule
(`tests/test-ui-surfaces.js` now holds all four):

- **A glyph is not a name.** Content beats `title` in the naming order, so a
  button whose text is `×` is *named* `×` — and the page had several, mutually
  indistinguishable. The conversation search box was worse: wrapped in a
  `<label>` that also contained the clear button, it was named `×` too. Give
  every symbol control an explicit `aria-label`, and translate it —
  `data-i18n-aria-label` exists for exactly that, because a page in Chinese
  whose controls answer only to English names is half-translated.
- **A clickable `<div>` is not a control.** Its role is `generic`, which never
  appears in a snapshot and cannot be resolved. The conversation list and the
  FILES tree were both built this way: fine for the operator, and to every
  agent, empty. `role="button"`, `tabindex="0"`, `aria-label`.
- **Nothing important may live behind CSS `:hover` alone.** `:hover` answers to
  a real pointer; `ui_hover` dispatches events. A control revealed at
  `opacity: 0` is one the operator can use and no agent ever can — so recess it
  instead (the per-conversation delete sits at `0.28`).
- **A modal announces itself and can always be closed.** `role="dialog"` named
  by its own heading through `aria-labelledby`, a close control named for what
  it closes, and Escape doing exactly what that control does. A modal an agent
  can open but not close wedges the tab: every later click lands on the
  overlay. `nameModal()` in `app/harness/26-layout.js` applies this to every
  `.modal-overlay` from the markup that is already there, so the tenth modal
  gets it without remembering to.

A name that identifies its target will often contain another control's name —
a conversation row and its own delete button both carry the thread's title.
That is not a defect to design away; the locator refuses the ambiguity and
names the candidates, and `exact: true` resolves it.

## What this does not cover

Inline styles are still widespread; the tokens exist and the shell uses them,
but the long tail of `style="..."` in the markup has not been migrated. That is
deliberate sequencing rather than an omission — the rules had to exist before
the migration had anything to migrate *to*. New code has no excuse.
