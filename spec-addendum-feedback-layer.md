# Feedback Layer — spec addendum

**Extends:** `spec.md` (Productivity Tracker).
**Posture:** additive. Existing entities — `Project`, `RecurringBlock`, `DailyTodo`,
`InboxItem`, `Review` — are unchanged. Projects and blocks remain pure
action-directors; nothing below instruments them per-project.

---

## Purpose / frame

A feedback-control layer over the existing tracker. It exists to convert each day
into corrected behavior, project-agnostically.

- **Is:** a hierarchical control loop — a setpoint, an error signal (drift), a
  controller (the nightly review), gain-limited corrections, and a permanence
  mechanism.
- **Is not:** an ultralearning project, a per-project feedback system, or a
  completion tracker. The unit of learning is *operating conduct*, not the project.

**Closure rule (load-bearing).** `intention(t+1) = f(gap(t))`. If the nightly
review does not change tomorrow's intention, the loop is open, compounding is
zero, and the system is a diary. Every feature below serves closure under a hard
friction budget (~2 min nightly; silence = on-task during the day).

---

## Operating model: two loops, one hinge

OODA and PDSA are the same loop at two tempos.

- **Intraday — OODA (tempo / damage control).** Observe → Orient → Decide → Act,
  continuous. Project-agnostic: you observe *yourself operating* against the day's
  plan, not a project. Buys: catching drift before it compounds.
- **Across-days — PDSA (validity / compounding).** Plan(+prediction) → Do →
  Study → Act(graduate / adapt / kill). One experiment at a time. Buys: learning
  the truth about what changes your conduct. The prediction is mandatory — the
  learning lives in the gap between predicted and observed.
- **The nightly review is the hinge:** it is the PDSA *Study* on the running
  experiment **and** the OODA *Orient* that sets tomorrow's lens.

The two stages that separate a loop from a diary are **Orient** and **Predict**.
Capture and Act alone are logging.

### Loop gains (noise discipline)

Each loop sees a smoothed version of the one below it. Corrections propagate up,
never down at full gain.

- Intraday: *logs* drift; does not trigger strategy change. A single bad block is
  noise.
- Nightly: acts with *small gain* — one micro-experiment / one focus for tomorrow,
  never a pivot.
- Weekly: acts on the *trend* — kill / keep / graduate experiments.
- Quarterly: the only loop permitted to edit the setpoint itself.

### WIP and permanence

- **WIP = 1.** At most one active operating experiment at a time.
- **Permanence via graduation.** An experiment that works graduates into a
  **Standing Practice** — an automatic default / routine / environmental change —
  and *exits the active loop*. It stops being measured; friction self-prunes. The
  summer's value is the accumulated stock of graduated practices, not the logs.
- **Quarterly re-audit.** Graduated practices can silently regress. Pull them back
  under observation briefly each quarter to confirm they still hold.

---

## The setpoint (drift referent)

Drift is **deviation from the day's operating stance.** The stance has two parts:

1. **What / when** — the time-allocated to-do list, written as-is in the morning
   planning ritual (`DailyTodo.content`). This is the existing artifact; no change
   to how it's authored.
2. **How** — the conduct definition below (the quality bar held *inside* every
   block). One standing definition, shared across all blocks — not one per block.

Drift = deviation from **either** the slot (wrong task for the clock) or the
conduct (right slot, wrong behavior).

**Re-decision discipline.** The plan is living and re-decidable at any time — that
is OODA Orient, not drift. But a re-decision is a **logged Orient event with a
reason**, never a silent edit. Silently editing the list to match what you did
launders drift as planning and destroys the signal. The *pattern of re-times*
("deep work always slides past lunch", "EA prep overruns 50%") is the richest
learning data; silent edits would erase it.

---

## Conduct definition (the focus bar)

The success condition for a block is **sustained single-context engagement** with
only permitted excursions. Behavioral proxy, not introspection: *the current
task's artifact is the single active context; no second task-context is open or
being acted on.* Completion is **not** required.

Excursions, by origin (the carve-outs that keep it humane):

- **Capture-to-inbox** — permitted, **write-only**, brief. You may *deposit* a
  thought to the GTD inbox; you may not *transact* on it (drafting the email is a
  switch). Not drift.
- **Exogenous interruption** — permitted if brief and **return-closing** (you come
  back to *the same* task). You didn't choose it. Not drift. The invariant is
  *return*, not duration — ten 45-second forks shred a block.
- **Self-initiated switch** — *not* an excursion. A logged re-decision with a
  reason. Legitimate, often correct, but it bends the plan visibly.

---

## The NOW panel (OODA overlay)

A frameless, always-on-top companion window (~320 px) that projects the daily list
sliced by the wall clock. Optional accelerator over the nightly spine — build only
if within-day drift proves to be a real, uncaught problem (see Build sequence).

### What it is / isn't

- A **projection**, not a new data source. It parses the same `DailyTodo.content`
  and renders only the active slice. One source, two views (full editor + now-slice).
- A **persistent companion**, not a pop-up. It never takes focus, never demands
  dismissal. This is the existing "ambient, not alarming" principle (cf. next-block
  indicator) extended — *not* a violation of the no-popups non-feature.
- It **exogenizes temporal drift**: the clock advances on its own, so it shows what
  you're *now* supposed to be on without any self-vigilance.
- It **cannot detect behavioral drift** and must not try — it can't read your
  screen, and attempting to would be surveillance. It only makes the discrepancy
  one glance cheap. It renders the setpoint and *your* marks; conduct stays yours.

### Display rules

- Shows the **deepest active block** for the current clock time, with its parent as
  breadcrumb (`Message Porter` under `TFT`; after the sub-block ends, just `TFT`).
- `# Goal:` lines surface as ambient context *while inside their parent block*,
  never as timed tasks.
- Leisure blocks render identically to work blocks. The panel is a
  *plan-adherence* instrument, not a productivity maximizer.
- **Stays visible during leisure blocks** (dim, like any on-plan state) — not
  suppressed.

### Salience ladder (capped low — "not too much escalation")

Time-driven only; never content-driven (it can't judge content). Rests in state 0
~95% of the day.

- **0 · on-plan** — small, dim, peripheral. `NOW: <task> · <n> min in`. Silent.
- **1 · handoff** — at a block's end time, auto-advances to the next block and
  brightens for a few seconds, then decays to dim. No dismissal.
- **2 · overrun** — end time passed, next block due, nothing acknowledged: holds
  slightly brighter with one quiet question (`<block> ended n min ago — still on
  it? [stay] [advance]`) until tapped. **Accent blue, never danger red** (red is
  reserved for cancelled blocks). No flash, no sound. This is the ceiling.

### Marks (silence = on-task; you touch it only to log a deviation)

- **capture** → write-only `InboxItem` (existing GTD flow), returns immediately.
- **interrupted** → logs an `Observation(kind=interruption)`; auto-closes on return.
- **switch / re-time** → the logged Orient event: re-decides the living plan in the
  moment, **writes the change back to `DailyTodo.content`** *and* logs an
  `Observation(kind=switch)` carrying the reason. List shows current truth; the
  Observation log preserves history. No silent edit path exists.

### Launcher note

Second `pywebview` window, frameless, `on_top=True`, reading the same Flask JSON
endpoints, alongside the main 1400×900. **The one thing to verify against the
backend before relying on it:** frameless always-on-top multi-window behavior
varies by `pywebview` platform backend.

---

## Plan grammar (descriptive recognizer)

The list is parsed by a **permissive recognizer for the dialect you already
write** — *not* a prescriptive DSL you must conform to. No off-the-shelf format
fits (org-mode/TaskPaper/NotePlan are adjacent but demand explicit times or
different nesting). The point of formalizing it is a single parse tree that every
consumer reads from (panel, timeline, overrun logic, write-back) — composition,
not syntax.

**Prime directive: graceful degradation.** A line that can't be resolved still
renders as plain text, inert (doesn't drive the clock). The parser never blocks,
never errors loudly. (Hard rejection is the failure mode that makes a free-text
ritual fiddle-able and kills compliance.)

### Grammar sketch

```
day      := line+
line     := indent? (block | goal | todo | freetext)
block    := timeref ":" label nest?
nest     := INDENT line+ DEDENT        # nesting is by INDENTATION (canonical)
goal     := "#" tag ":" freetext       # ambient context, not time-bound
todo     := ("o" | "x") WS freetext    # checklist under a block: o open, x done
timeref  := time ("-" time)?
time     := H (":" MM)? meridiem?      # meridiem optional → resolver fills it
```

- **Nesting = indentation.** Stray `(` / `)` are tolerated and stripped as
  decoration, never required.
- **Tags are emergent.** `# Goal:` is one tag; do not pre-define a vocabulary. Let
  `# note:`, `# energy:`, etc. crystallize from real usage, then formalize.
- **Checklists.** An indented `o <text>` / `x <text>` under a block is that
  block's checklist item (open/done; lowercase only, text required — anything
  else degrades to freetext as usual). The panel shows the active block's OPEN
  items as one extra row — first item plus a visible `⌄N` count that toggles
  the full list — and checking one writes that line's `o` back to `x` (the only
  write-back besides the switch reason). No open items, no row.

### Two resolvers (where the real work is)

1. **Time resolver** — the list is read as a **24-hour clock**: `13` is 13:00,
   `1` is 01:00, `12` is noon. An `am`/`pm` suffix is optional and is the only
   thing that shifts an hour, so nothing is ever guessed. The monotonic rule
   still applies for the day boundary alone: a time earlier than the one above it
   belongs to the next day (`22:00 → 23:00 → 00:30 → 01:00`).
   *(Superseded the original AM/PM monotonic heuristic, which read a bare `1` as
   13:00 and was the one component that could guess wrong.)*
2. **Active-block selector** — given the parse tree + wall clock, return the
   deepest block covering *now*. This is the panel's entire engine.

### Implementation

Left-to-right state machine taking each line as an event, updating a tree (the
model org-mode-style parsers use). Operates on `DailyTodo.content`; the parse is
**derived**, so no new storage for the list itself.

---

## Data model (new tables — all Project-decoupled)

```
- Observation:
  id, captured_at,
  kind (enum: interruption | switch | note),
  text,                         # for kind=switch: the re-decision reason
  now_block (text, nullable),   # active block label at capture time
  tag (text, nullable)          # optional "during X"; never required
  # kind=interruption: exogenous, return-closing excursion
  # kind=switch: logged Orient event; also written back into the list
  # kind=note: free observation surfaced in the nightly review
  # (captures are write-only InboxItems — existing table, no new kind)

- DailyReview:                  # the nightly hinge (PDSA Study + OODA Orient)
  id, date,
  study (text),                 # active experiment vs. its prediction
  synthesis (text),             # what the day's observations showed
  tomorrow_focus (text),        # the single operating focus for tomorrow
  created_at
  # one per day; distinct from the existing weekly/quarterly/yearly Review

- Experiment:
  id, scope (enum: operating | skill),
  hypothesis (text), prediction (text),
  status (enum: active | graduated | killed),
  started_at, resolved_at (date, nullable),
  resolution_note (text, nullable),
  last_audited (date, nullable)
  # WIP: at most one status=active with scope=operating at a time
  # status=graduated → functions as a Standing Practice
  # last_audited set on quarterly re-audit
```

List re-decision **history lives in the Observation log**, not in list versioning.

---

## Loop → surface mapping

| Loop | Tempo | Surface | Status |
|---|---|---|---|
| Set setpoint | morning | planning ritual (`DailyTodo`) | existing |
| OODA (intraday) | continuous | NOW panel + Observation marks | new (optional) |
| PDSA Study + OODA Orient | nightly | `DailyReview` | new |
| Trend / experiment kill·keep·graduate | weekly | Review tab (extended) | existing tab |
| Re-audit practices + edit setpoint | quarterly | Review tab (extended) | existing tab |

---

## Build sequence

Build the slow loop first; add the fast loop only if it earns its place.

**Phase A — PDSA spine (nightly).** May follow MVP; needs no panel.
1. `Experiment` table + `DailyReview` table.
2. Nightly review surface: Study current experiment vs. prediction → Orient
   tomorrow's focus → start / graduate / kill experiment.

**Phase B — plan grammar.** Foundational for the panel; also upgrades the existing
timeline render.
3. Line-event parser over `DailyTodo.content`; indentation nesting; goal/tag
   surfacing.
4. AM/PM monotonic resolver **+ manual per-line override**.
5. Active-block selector (deepest block covering now).

**Phase C — NOW panel (OODA overlay).** Conditional: build only if within-day
drift is a real, uncaught problem.
6. Second `pywebview` window (frameless, on-top) reading existing JSON.
7. Three salience states (on-plan / handoff / overrun), time-driven, capped.
8. Marks → capture (`InboxItem`) / interruption / switch; re-time write-back +
   logged Orient (`Observation`).

**Phase D — synthesis upgrade.**
9. Weekly Review reads Observation patterns + experiment outcomes (trend
   detection, graduate / kill).
10. Quarterly re-audit of graduated practices + setpoint review.

---

## Guardrails / non-features (additions)

- Experiments target **operating conduct, never therapeutic process.** Care and
  health blocks display on the panel like any other; they are attended, not
  optimized.
- Career development is a **slow-loop** thread (weekly / quarterly) — never given
  intraday instrumentation; its signal latency is months and daily capture is pure
  noise.
- The panel **never reads attention or screen content.** No surveillance.
- **No silent edits** — every re-decision is logged with a reason.
- The parser **never hard-errors** — unparseable lines render inert, not rejected.
- Panel escalation is **capped at the overrun question** — calm by default, no
  audio (consistent with the existing no-audio non-feature), no focus-steal.
- All existing `spec.md` non-features carry over.

---

## Open inputs (author-owed)

1. **Conduct definition** — drafted above (the focus bar). ✔
2. **First experiment + prediction** — required to seed Phase A. Pick one recurring
   operating constraint, state a hypothesis and a *prediction* of what changing it
   will do. (Without a prediction, PDSA is tinkering.)
3. ~~**AM/PM override UX**~~ — resolved by reading the list as a 24-hour clock
   (see Two resolvers): bare hours are literal, `am`/`pm` stays available, so
   there is no guess left to override. ✔
