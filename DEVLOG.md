# Dev Log

## Stage 1: Skeleton

All 6 files are created. Here's a summary of what's in place:

app.py — Flask with all 7 routes, loads config.json, calls init_db(), launches pywebview on main thread with Flask on a daemon thread.
storage.py — get_conn() + init_db() with all 7 tables: project, recurring_block, block_override, daily_todo, inbox_item, review, review_annotation.
aggregator.py — fetch_gcal(url) (urllib) and fetch_sheets(url, credentials_path) (gspread).
templates/index.html — Static shell with sidebar Today tab, 38/62 panel layout, Inter + JetBrains Mono + ical.js from CDN.
static/style.css — All CSS variables from the spec palette (including 6 block colors), base resets, panel layout.
static/app.js — state object with all fields from spec, loadAll() via Promise.all, five empty render functions.

## NOW panel (feedback layer, Phases B + C)

Built the always-on-top companion window from spec-addendum-feedback-layer.md.

- static/plan.js — plan grammar: parsePlan (blocks / bullets / goals / freetext, indentation nesting), an AM/PM monotonic resolver to semantic minutes (24-hour literal for hour ≥ 13 as the escape hatch), and activeBlockAt / nextBlockAt. Pure, never throws. Covered by a 113-case node suite.
- templates/panel.html + static/panel.js — GET /panel serves the 320px shell; panel.js does all panel state/rendering/fetching (60s todo poll + 5s clock tick). Salience ladder 0 on-plan → 1 handoff (5-min ack grace) → 2 overrun question, capped. Marks: capture (InboxItem), interrupted / switch (Observation, switch also PATCHes the list with a required reason). style.css got a NOW-panel section reusing the existing palette.
- app.py — GET /panel route, a second frameless on_top window (PanelApi.set_expanded resizes anchored to the bottom edge so the switch form grows upward on-screen), main-window close destroys the panel. storage.py — observation.now_block column.
- Built and verified with a background multi-agent workflow (parser breaker, spec-compliance, correctness, and independent E2E). Fixes applied from the review: parser regex no longer turns "9:30 Standup" into a phantom block; single-time blocks that would inherit an end ≤ start go open-ended; yesterdayRoots is invalidated on date rollover; overrun counters wrap correctly past midnight; the overrun question sits outside the clipped main area; mark/form clicks no longer bubble to the ack handler.
