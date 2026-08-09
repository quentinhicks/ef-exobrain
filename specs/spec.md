> **Historical.** The original build specification. The data model and
> constraints still largely hold, but the interface described here — a left
> sidebar with Today/Review tabs, and a daily to-do list — was replaced by a
> single phone-width column in 2026-08. See the README for the current shape.

# Productivity Tracker — spec.md

## Purpose

Single daily view aggregating Google Calendar events and Google Sheets
deadlines with a local time-block template, daily planning ritual,
and GTD-based capture system. Single machine, local only.

## External sources (read-only, no OAuth)

- Google Calendar: private iCal URL (stored in config.json)
- Google Sheets: one master sheet, published as CSV
  (single URL stored in config.json)
- Comprehensive to-do: local markdown file
  (path stored in config.json as "comprehensive_todo_path")

## config.json

{
"gcal_ical_url": "...",
"sheets_csv_url": "...",
"comprehensive_todo_path": "/path/to/todo.md",
"weekly_review_day": 0
}

# weekly_review_day: 0=Monday … 6=Sunday, default 0

---

## Data stored locally (SQLite)

### Core tables (MVP)

- Area:
  id, name, active (bool),
  type (enum: standard | review | sleep)

  # standard: normal work projects

  # review: Weekly Review / Quarterly Review / Yearly Review

  # sleep: hidden from timeline entirely

- RecurringBlock:
  id, label, color, day_of_week (int 0–6),
  start_time, end_time, active (bool),
  area_id (FK → Area, nullable)

- BlockOverride:
  id, block_id, date, cancelled (bool)

- DailyTodo:
  id, date, content (text),
  planning_started_at (datetime, nullable),
  planning_finished_at (datetime, nullable),
  created_at

### Later feature tables (GTD)

- InboxItem:
  id, content (text), captured_at,
  status (enum: null | 'active' | 'on_hold'),
  area_id (FK → Area, nullable),
  defer_until (date, nullable)
  # status=null: unprocessed, visible in Inbox
  # status set + area_id set: processed, hidden from Inbox
  # defer_until > today: hidden from all surfaces

### Later feature tables (Review)

- Review:
  id, type (weekly | quarterly | yearly),
  date, content (text), created_at

  # Record existence = review completed for that period

- ReviewAnnotation:
  id, file_hash (text), line_index (int),
  annotation (enum: done | not_done), created_at
  # Annotations against comprehensive_todo markdown file
  # file_hash used to invalidate if file changes externally

---

## Layout

### Tab navigation

- Left sidebar, icon + label per tab
- Tabs: Today | Review
- No top navigation bar

### Today tab — two panels side by side

- 38% left (task surface) / 62% right (timeline)
- Separated by single 1px border, no gutter

---

### Left panel: Task surface

#### Section 1: Daily to-do + planning ritual

**States:**

- Unstarted: "Start Planning" button centered in section,
  with today's date as header
- Planning: text area active, 10-minute countdown timer
  displayed at bottom of text area (MM:SS, counts down from 10:00),
  "Finish" button below timer
- Finished: text area remains editable (auto-saves on blur),
  timer replaced by "Planned at HH:MM" label (from planning_started_at),
  no re-trigger of timer on edit

**Pre-population:**

- If today's DailyTodo content is empty and planning has not started,
  pre-populate text area with yesterday's content as a reference draft

**Timer behavior:**

- Counts down from 10:00
- At 0:00: timer label turns accent color, no sound, no popup
- "Finish" button available at any time regardless of timer state
- Pressing "Finish" records planning_finished_at

#### Section 2: Active project items [LATER FEATURE]

- Visible only when current time falls within a RecurringBlock
  whose area.type = 'standard' and area_id is set
- Shows InboxItems where:
  area_id = current block's area_id
  AND status = 'active'
  AND (defer_until IS NULL OR defer_until <= today)
- Header: "[Project Name] — active items"
- Read-only in this view
- Visually separated from Section 1 (divider + subtle background shift)

#### Section 3: Inbox capture [LATER FEATURE]

- Header: "In"
- Growing table. Columns:
  | Item (text) | Status (—/Active/On Hold) | Project (dropdown) |
  | Defer until (date picker, shown on row hover/expand) |
- New row: Enter key or "+ Capture" button
- Status and Project dropdowns default to "—"
- When BOTH status and area_id are set: row fades out (200ms),
  item persisted in DB with those values
- On Hold + defer_until: item hidden until defer_until <= today,
  then reappears in Inbox with "↩ returned" tag
- Active + defer_until: item hidden until defer_until <= today,
  then resurfaces in Section 2 during relevant timeblock
- Project dropdown: active=true, type=standard only
  (review and sleep projects excluded)

---

### Right panel: Day timeline

**Display:**

- Full 24 hours, no scroll
- Each hour = panel_height / 24 (fixed, fills panel)
- Projects with type='sleep' not rendered (no visual slot)
- Future (later feature): responsive shrink when window is not
  full screen such that timeline would become unreadably small

**Layers:**

- Layer 1: RecurringBlocks for this day of week
  - Color-coded per block's assigned color (6-color palette)
  - Area name label if area_id is set
  - type='sleep' blocks not rendered
- Layer 2: GCal events from iCal URL
  - #2a2a2a fill, #e8e8e8 text, left border in accent color
  - Visually distinct from user blocks
- Layer 3: Today deadline markers
  - Items from Sheets CSV due today shown as thin marker strip
  - at the top of the timeline panel

**Next block indicator:**

- Persistent label outside the timeline scroll area (top of panel):
  "Next: [Block Label] at HH:MM"
- If currently in a block: "Now: [Block Label] · Next: [Block Label] at HH:MM"
- Disappears after last block of the day
- Uses secondary text color, not accent — ambient, not alarming

**Block interaction:**

- Click a RecurringBlock to toggle BlockOverride for that date
  (cancel/restore this occurrence only)
- Cancelled blocks shown with strikethrough label + danger color

**Navigation:**

- Left/right arrows to move ±3 days from today
- "Today" button snaps back

**Below timeline: Upcoming deadlines strip**

- Sheets CSV items where done=FALSE and due_date ≤ 14 days
- Sorted ascending, grouped by date
- Read-only

**Data freshness:**

- Manual refresh button (top of panel, subtle)
- Shows "Last fetched: X min ago" or "Fetch failed" label
- No auto-fetch on timer

---

## Review tab [LATER FEATURE — partially specified]

### Layout

- Three sections stacked vertically or tabbed within the Review tab:
  review type selector | reflection editor | comprehensive to-do panel

### Review type logic

- Weekly Review: available every week on the day set in config.json
  (weekly_review_day). Available if no Weekly Review record exists
  for the current week (Mon–Sun window).
- Quarterly Review: available on the first weekly_review_day occurrence
  after April 1, July 1, October 1. Available if no Quarterly Review
  record exists for the current quarter.
- Yearly Review: available on the first weekly_review_day occurrence
  after January 1. Available if no Yearly Review record exists
  for the current year.
- When multiple types are due: surface all that are due,
  most specific first (Yearly > Quarterly > Weekly)
- Review type selector always visible to allow manual override

### Review blocks in timeline

- Projects with type='review' render in timeline like standard blocks
- When current time is within a review-type block,
  Review tab gets a subtle indicator (dot on tab icon)
- Navigating to Review tab while in a review block
  auto-selects the appropriate review type

### Reflection editor

- Plain text area, auto-saves on blur
- Persisted in Review table with type + date
- Past reviews accessible via date picker (read past entries,
  current entry editable)

### Inbox surfacing during review [LATER FEATURE]

- InboxItems with status=null (unprocessed) surfaced for processing
  during review session
- Exact UX TBD

### Comprehensive to-do panel

- Reads markdown file from comprehensive_todo_path in config.json
- Rendered as formatted markdown (read-oriented)
- Light annotation layer:
  - Click a line to cycle: unmarked → done → not done → unmarked
  - done: subtle green left border + secondary text color
  - not done: subtle red/amber left border, full opacity text
  - Annotation state persisted in ReviewAnnotation table
  - file_hash stored per annotation; if file changes and hash
    mismatches, annotations are cleared with a warning label
    "File changed — annotations reset"
- No full editing of the markdown file content from within the app
  (file edited externally)

---

## Block template editor (modal or second tab within Today)

- List of RecurringBlocks: label, color, days, times, project
- Form: label, color (6-option palette), day checkboxes,
  start/end time, project dropdown
  (all types shown here including review and sleep)
- Toggle active/inactive
- Area manager inline: add/archive areas, set type

---

## Visual design

### Principles

- Dark, sleek, minimalist
- No decoration that isn't load-bearing information
- Density without clutter

### Color palette

- Background: #0d0d0d
- Surface (panels): #161616
- Border/divider: #2a2a2a
- Text primary: #e8e8e8
- Text secondary: #666666
- Accent: #5b8af5 (active state, today marker,
  current block highlight)
- Danger: #c0392b (cancelled blocks only)
- On-hold: #a0a0a0 (muted, de-emphasized)
- Annotation done: #2d4a2d (green-tinted surface)
- Annotation not done: #4a2d2d (red-tinted surface)

### Block color palette (6 fixed options)

#5b8af5 (blue), #4caf7d (green), #e0a030 (amber),
#a06cd5 (purple), #e05c5c (red), #4ab3c2 (teal)

### Typography

- UI font: Inter (CDN)
- Text areas (daily to-do, review editor): JetBrains Mono (CDN)
- No font below 12px
- Weights: 400 body, 600 labels

### Component rules

- No box shadows, no gradients
- Borders: 1px solid #2a2a2a only
- Border-radius: 4px maximum
- Hover: background #1f1f1f, no animation
- One transition: InboxItem fade-out 200ms
- Scrollbars: thin, dark, no autohide

---

## Empty and error states

- First run (no blocks set): placeholder text in timeline panel
  "No blocks yet — open Block Editor to add your schedule"
- Empty daily to-do (before planning started): placeholder
  "Press Start Planning to begin your 10-minute ritual"
- Fetch failed: "Last fetch failed — check your config.json URLs"
  shown in place of last fetched label
- Sheets no items due: "No deadlines in the next 14 days"
- Review tab, no review due: "No review due — next [type] on [date]"

## Overlapping blocks

- Two RecurringBlocks may not occupy overlapping time on the same
  day of week. Validation on save: if overlap detected, show inline
  error "Overlaps with [existing block label]" and reject save.

---

## Build sequence

### MVP (build in this order)

1. Skeleton: app.py, storage.py, aggregator.py,
   index.html, app.js, style.css
2. Block template editor + area manager
3. Block override (click to cancel occurrence)
4. Daily to-do pre-population from yesterday
5. Planning ritual (Start/Finish buttons + 10-min timer)
6. Next block indicator

### Later feature: GTD capture system

7. Project types (standard/review/sleep) wired into schema
8. InboxItem table + Inbox capture panel
9. Processed-item filtering (fade-out on both fields set)
10. Defer system (defer_until column + visibility rule)
11. Active project items surface (context-sensitive Section 2)

### Later feature: Review tab

12. Review table + ReviewAnnotation table
13. Review type logic (weekly/quarterly/yearly trigger rules)
14. Review tab layout: type selector + reflection editor
15. Comprehensive to-do panel + annotation layer
16. Review block integration (tab indicator when in review block)
17. Inbox surfacing during review

### Later feature: Timeline responsive shrink

18. Window resize detection + timeline density scaling
    (exclude sleep projects from display entirely)

---

## Explicit non-features

- No authentication (LAN access is deliberately unauthenticated, same-WiFi only)
- ~~No mobile view~~ SUPERSEDED 2026-08: the whole app IS the mobile view (9c shell)
- No subtasks or task dependencies
- No drag-to-resize blocks
- No audio notifications or popups
- Habit tracking: narrow weekly-habit form only, see spec-journal.md
- No recurring inbox items
- No GTD Reference lists (Waiting For got a surface in the GTD tab, 2026-08)
- No natural language date parsing
- No markdown file editing from within the app
- No packaging/distribution (app runs from source only)
- No auto-start on login (user runs manually or creates their own alias)

## Launcher

- pywebview wraps the Flask app in a native window
- Window title: 'Productivity Tracker'
- Default size: 1400 × 900
- Flask server runs on a daemon thread; pywebview opens on the main thread
- No browser required to run the app

## Architecture pattern

- API-driven SPA
- Flask serves one static shell (index.html) and JSON endpoints only
- Flask never renders data into HTML templates (no Jinja2 data injection)
- All data fetching, rendering, and state management lives in app.js
- Every Flask route returns JSON except GET / which returns the shell

## Frontend state architecture

### Pattern: load-on-start, action-driven updates

- All data fetched once on app load via Promise.all across all API endpoints
- External data (GCal, Sheets) re-fetched only on manual refresh — no polling
- Single global state object in app.js holds all runtime data

### State object shape

- currentDate (Date): drives timeline rendering and day navigation
- gcalEvents, deadlines, blocks, projects, todo: populated on load
- lastFetched (Date|null): drives the fetch status label
- planningState ('unstarted'|'planning'|'finished'): drives planning ritual UI
- timerSeconds (int): counts down from 600, local only, not persisted
- timerInterval (id|null): setInterval reference for cleanup

### Update rules

- Navigation (±3 days): update currentDate, call renderTimeline() only
- Planning ritual state changes: update planningState, call renderTodo() only
- Timer ticks: decrement timerSeconds, call renderTimer() only
- Manual refresh: re-fetch all external data, call renderAll()
- Save operations (todo content, block overrides): PATCH/POST to Flask,
  no re-render unless response changes displayed state

### Render functions

- renderAll(), renderTimeline(), renderTodo(), renderDeadlines(), renderTimer()
- Each reads from state only — no function causes side effects in another
- No render function calls another render function

## Launch

- pywebview wraps Flask in a native window
- Flask runs on a daemon thread with use_reloader=False
- Single launch mode: python app.py opens the window directly
- No development/production split
- Window: title='Productivity Tracker', width=1400, height=900
