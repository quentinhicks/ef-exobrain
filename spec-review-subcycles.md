# Review Subcycles — spec-review-subcycles.md

Extends `spec.md` and `spec-addendum-feedback-layer.md`. Defines the weekly,
monthly, and quarterly review cadences. The yearly review (8760 hours process)
is out of scope here but shares schema with the quarterly (see §4).

---

## 0. Design Principles

- **Invariant grammar across all cadences:** every review performs Assess →
  Diagnose → Decide → Commit. The objects being reviewed change with scale;
  the grammar does not.
- **Medium matches cognitive mode:** weekly and monthly are app-native
  (convergent, pattern-matching). Quarterly has a paper generative phase
  followed by app extraction (divergent then convergent).
- **Feed-forward coupling:** each level's structured output becomes the
  pre-populated context for the level above. Weekly feeds monthly; monthly
  feeds quarterly; quarterly feeds yearly.
- **Consistent review load:** time budgets are fixed by design, not by how
  much there is to review.
- **No partial saves:** every review is atomic. Either submit a complete
  review or close without saving. No draft or resume state.

---

## 1. Weekly Review

**Cadence:** every ~7 days.
**Time budget:** 15–30 minutes.
**Medium:** app-native entirely.
**Cognitive mode:** operational + single learning capture.

### 1.1 Operations (in order)

1. **Inbox clear:** review all InboxItems with status=null. Assign status +
   project or defer. This is the GTD weekly sweep. The app surfaces these
   automatically in the weekly review UI.

2. **Project status check:** read-only sweep of active projects. No editing
   here — this is a pulse check, not a planning session. The app surfaces
   each active project with its last BlockFeedback date and hit rate for the
   week.

3. **Experiment check:** for the current WIP=1 experiment, is the prediction
   still being tested? Any early signal? One-line note, optional.

4. **Learning capture:** one sentence. The single most useful thing learned
   or noticed this week. This is the only required text field. It feeds
   directly into the monthly synthesis.

5. **Next week's focuses:** 1–3 short phrases naming what to prioritize next
   week. Not tasks — orientations. These surface in the read-only review
   panel during daily execution.

### 1.2 Schema

```sql
CREATE TABLE WeeklyReview (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start_date  DATE NOT NULL UNIQUE,   -- Monday of the reviewed week
    learning_capture TEXT NOT NULL,           -- required; one sentence
    next_focuses     TEXT,                    -- JSON array of 1–3 strings
    inbox_cleared_at DATETIME,                -- nullable; set when inbox sweep done
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 1.3 UI surface

- Triggered manually from the Review tab (no auto-prompt).
- Single scrollable form. Sections render in the operation order above.
- Inbox section: same table UI as GTD capture panel, filtered to
  status=null items. Changes persist immediately (inbox is not part of
  the atomic submit — clearing inbox items is always live).
- Project status section: read-only cards, one per active project, showing
  last feedback date and weekly hit rate computed from BlockFeedback.
- Learning capture: single textarea, required before submit.
- Next focuses: up to 3 short text inputs.
- Submit writes WeeklyReview row atomically. No partial saves.

---

## 2. Monthly Review

**Cadence:** every ~30 days.
**Time budget:** 60–90 minutes.
**Medium:** app-native entirely.
**Cognitive mode:** convergent pattern-matching against logged data.

### 2.1 Pre-populated brief (read before reviewing)

The app generates a brief from existing data before the review form appears:

- Last 4 WeeklyReview.learning_capture entries, in chronological order.
- Last 4 WeeklyReview.next_focuses entries.
- BlockFeedback hit rate per project for the month (computed).
- DailyReview.synthesis entries for the month (from the feedback layer).
- Current active experiment + its prediction + days running.
- Standing practices list with last regression flag date if any.

This brief is read-only. The user reads it, then proceeds to the form.

### 2.2 Operations (in order)

1. **Experiment verdicts:** for each experiment that has run ≥ 2 weeks or
   reached its natural endpoint, assign a verdict: `graduate` (becomes
   standing practice), `redesign` (continue with modification), or `drop`
   (abandon). Brief notes per verdict, optional.

2. **Project velocity:** for each active project, mark as `on track`,
   `stalled`, or `completed`. One-line note for stalled or completed.

3. **Standing practice audit:** quick check — are all standing practices
   still running? Flag any that have silently regressed.

4. **Monthly synthesis:** 2–3 sentences. What was the shape of this month?
   What changed? This is the signal that feeds the quarterly brief. It
   should compress the month, not recap it.

5. **Next month's focuses:** 1–3 orientations, same format as weekly.
   Informed by experiment verdicts and project velocity.

### 2.3 Schema

```sql
CREATE TABLE MonthlyReview (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    month        DATE NOT NULL UNIQUE,   -- first day of reviewed month
    synthesis    TEXT NOT NULL,          -- 2–3 sentences; required
    next_focuses TEXT,                   -- JSON array of 1–3 strings
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE MonthlyExperimentVerdict (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    monthly_review_id INTEGER NOT NULL REFERENCES MonthlyReview(id),
    project_id        INTEGER NOT NULL REFERENCES Project(id),
    verdict           TEXT NOT NULL CHECK(verdict IN ('graduate','redesign','drop')),
    notes             TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE MonthlyProjectStatus (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    monthly_review_id INTEGER NOT NULL REFERENCES MonthlyReview(id),
    project_id        INTEGER NOT NULL REFERENCES Project(id),
    status            TEXT NOT NULL CHECK(status IN ('on_track','stalled','completed')),
    notes             TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.4 UI surface

- Brief renders first, full-width, scrollable, collapsed by default with
  expand toggle. User must explicitly open it — not forced.
- Form sections render in operation order.
- Experiment verdicts: one row per experiment needing verdict. Radio buttons
  for graduate/redesign/drop. Optional notes field per row.
- Project velocity: one row per active project. Radio buttons for status.
  Notes field appears only for stalled/completed.
- Standing practices: checklist — still running (yes/no) per practice.
- Synthesis: textarea, required.
- Next focuses: up to 3 short text inputs.
- Submit writes all tables atomically. No partial saves.

---

## 3. Quarterly Review

**Cadence:** every ~90 days.
**Time budget:** half day (3–5 hours total across both phases).
**Medium:** paper generative phase → app extraction phase.
**Cognitive mode:** divergent (paper) then convergent (app).

### 3.1 Phase 1 — Pre-brief (app, ~15 min)

Before leaving the app for paper, the app generates a quarterly brief:

- Last 3 MonthlyReview.synthesis entries.
- Last 3 MonthlyReview.next_focuses entries.
- Experiment history for the quarter: all verdicts from MonthlyExperimentVerdict.
- Project completions and stalls for the quarter.
- LifeAreaRating from the previous quarterly review (all 12 areas, for comparison).
- Annual theme and major goals from the current yearly review.

Print or read this brief before going to paper.

### 3.2 Phase 2 — Paper generative phase (~2–4 hours)

Done entirely offline. The app has no role here except generating the brief.
Structure mirrors the 8760 hours process but scoped to the quarter:

1. **Rate all 12 life areas 1–7.** Honest current-state assessment.
   The three lowest-rated areas are flagged for deep review.

2. **Deep review of bottom 3 areas.** For each: current status, what went
   well, what didn't, what the most important problem is (Hamming question),
   what one thing would have the most impact.

3. **Quarterly theme (optional).** A one-phrase orientation for the next
   quarter.

4. **Next quarter's focuses.** 3–5 things to prioritize. Can be area-based,
   project-based, or experiment-based.

5. **Hamming insight.** The single most important thing not currently being
   worked on. One sentence.

### 3.3 Phase 3 — App extraction (~30 min)

After paper work is complete, open the app and enter the structured outputs.
The extraction form asks only for the decision-relevant outputs — not a
digitization of all paper notes.

Optional: upload a photo or scan of raw paper notes as a file attachment.
Stored as a file path; the app does not parse the contents.

### 3.4 Schema

```sql
CREATE TABLE QuarterlyReview (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    quarter          TEXT NOT NULL UNIQUE,  -- e.g. "2026-Q2"
    theme            TEXT,                  -- optional one-phrase orientation
    focuses          TEXT,                  -- JSON array of 3–5 strings
    hamming_insight  TEXT NOT NULL,         -- one sentence; required
    paper_notes_path TEXT,                  -- file path to uploaded scan; nullable
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE LifeAreaRating (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    quarterly_review_id INTEGER REFERENCES QuarterlyReview(id),
    yearly_review_id    INTEGER REFERENCES YearlyReview(id),
    -- exactly one of the above two must be non-null (enforced in app logic)
    life_area           TEXT NOT NULL CHECK(life_area IN (
                            'values_purpose', 'contribution_impact',
                            'location_tangibles', 'money_finances',
                            'career_work', 'health_fitness',
                            'education_skills', 'social_relationships',
                            'emotions_wellbeing', 'character_identity',
                            'productivity_organization', 'adventure_creativity'
                        )),
    rating              INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 7),
    is_bottom_3         BOOLEAN NOT NULL DEFAULT 0,
    notes               TEXT,              -- required when is_bottom_3 = 1
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.5 UI surface

- **Brief page:** renders full quarterly brief. Print button (pywebview
  `window.print()`). "Begin extraction" button appears at bottom.
- **Extraction form:** two sections.
  - *Life area ratings:* 12 rows, one per area, 1–7 selector each.
    On submit of this section, bottom 3 auto-flagged and notes fields
    expand for those three areas. Notes required for bottom 3 before
    proceeding.
  - *Quarterly outputs:* theme (optional), focuses (3–5 inputs), Hamming
    insight (required), file upload for paper notes.
- Submit writes QuarterlyReview and all LifeAreaRating rows atomically.

---

## 4. Schema Consistency Note — Yearly Review

The yearly review uses the same LifeAreaRating table, with yearly_review_id
set instead of quarterly_review_id. Rating scale is 1–7 across all cadences.

YearlyReview table (stub — full spec is the 8760 hours process):

```sql
CREATE TABLE YearlyReview (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    year             INTEGER NOT NULL UNIQUE,
    annual_theme     TEXT,
    major_goals      TEXT,     -- JSON array of {goal, description} objects
    paper_notes_path TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. Feed-Forward Coupling Summary

```
WeeklyReview.learning_capture (×4)      ──► MonthlyReview brief
WeeklyReview.next_focuses (×4)          ──► MonthlyReview brief
BlockFeedback hit rates (monthly agg)   ──► MonthlyReview brief
DailyReview.synthesis (monthly agg)     ──► MonthlyReview brief

MonthlyReview.synthesis (×3)            ──► QuarterlyReview brief
MonthlyExperimentVerdict history        ──► QuarterlyReview brief
MonthlyProjectStatus history            ──► QuarterlyReview brief
LifeAreaRating previous quarter         ──► QuarterlyReview brief

QuarterlyReview.focuses (×4)            ──► YearlyReview brief
LifeAreaRating all quarters             ──► YearlyReview brief
QuarterlyReview.hamming_insight (×4)    ──► YearlyReview brief
```

---

## 6. Read-Only Review Panel (Today Tab)

A click-triggered overlay (same pattern as block template editor modal).
Surfaces orientation content during execution. Read-only; no editing.

Contents:
- Annual theme + major goals (from YearlyReview, current year)
- Current quarterly focuses (from QuarterlyReview, current quarter)
- Active experiment + prediction (from Project where feedback_class='fast'
  and status='active', current WIP=1 experiment)

Query dependencies: YearlyReview, QuarterlyReview, Project tables must all
exist before this panel can be built.

---

## 7. Trigger Logic — Subsumption Hierarchy

Reviews are not auto-prompted (consistent with spec.md "no popups"). The
Review tab displays which review type is currently due, derived entirely from
completion timestamps.

### 7.1 Subsumption rule

A higher-cadence review resets the clock for all lower cadences beneath it:

| Review completed | Resets clock for         |
|------------------|--------------------------|
| Yearly           | Yearly, Quarterly, Monthly, Weekly |
| Quarterly        | Quarterly, Monthly, Weekly |
| Monthly          | Monthly, Weekly          |
| Weekly           | Weekly only              |

### 7.2 Effective last date query

For each cadence, the effective last review date is the MAX(created_at)
across all review types that satisfy it:

```python
def get_effective_last_dates(db):
    """
    Returns dict of {cadence: last_datetime} using subsumption hierarchy.
    All four tables are queried; missing rows return None.
    """
    rows = db.execute("""
        SELECT 'yearly'    AS cadence, MAX(created_at) AS last_date
        FROM YearlyReview
        UNION ALL
        SELECT 'quarterly', MAX(created_at)
        FROM (
            SELECT created_at FROM QuarterlyReview
            UNION ALL SELECT created_at FROM YearlyReview
        )
        UNION ALL
        SELECT 'monthly',   MAX(created_at)
        FROM (
            SELECT created_at FROM MonthlyReview
            UNION ALL SELECT created_at FROM QuarterlyReview
            UNION ALL SELECT created_at FROM YearlyReview
        )
        UNION ALL
        SELECT 'weekly',    MAX(created_at)
        FROM (
            SELECT created_at FROM WeeklyReview
            UNION ALL SELECT created_at FROM MonthlyReview
            UNION ALL SELECT created_at FROM QuarterlyReview
            UNION ALL SELECT created_at FROM YearlyReview
        )
    """).fetchall()
    return {row['cadence']: row['last_date'] for row in rows}
```

### 7.3 Due thresholds

| Cadence   | Due after   |
|-----------|-------------|
| Weekly    | 7 days      |
| Monthly   | 30 days     |
| Quarterly | 90 days     |
| Yearly    | 365 days    |

### 7.4 Priority ordering

When multiple cadences are due simultaneously, the Review tab surfaces the
rarest due review first. Priority: Yearly > Quarterly > Monthly > Weekly.

The Review tab shows a single "Due: [type]" indicator, not a list of all
overdue items. Once the highest-priority due review is completed, the next
(if any) surfaces.

### 7.5 Overdue indicator

If any review is due, the Review tab nav item shows a small dot in the
accent color (#5b8af5). No modal, no notification, no blocking.

---

## 8. Seed Data

On schema initialization, insert a seed yearly review record reflecting the
8760 hours review completed January 1, 2026. This correctly seeds all four
cadence clocks via the subsumption hierarchy.

```sql
-- Run once during schema init (storage.py), after CREATE TABLE statements.
-- Inserts seed yearly review dated 2026-01-01.
INSERT OR IGNORE INTO YearlyReview (year, annual_theme, major_goals, created_at)
VALUES (
    2026,
    NULL,   -- theme not captured at seed time
    NULL,   -- goals not captured at seed time
    '2026-01-01 00:00:00'
);
```

Effect on cadence clocks as of seed date (2026-01-01):
- Yearly last: 2026-01-01 → next due: ~2027-01-01
- Quarterly last: 2026-01-01 → next due: ~2026-04-01
- Monthly last: 2026-01-01 → next due: ~2026-02-01
- Weekly last: 2026-01-01 → next due: ~2026-01-08
