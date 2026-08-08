// People CRM phone surface (spec-people-crm.md) added below. Extra Worker
// secrets it needs, in addition to the existing INTERNAL_SECRET:
//   PEOPLE_PASS_HASH     — SHA-256 hex of (PEOPLE_SALT + passphrase). The
//                          passphrase itself is NEVER stored, only this hash.
//   PEOPLE_SALT          — random string folded into the passphrase hash.
//   PEOPLE_COOKIE_SECRET — HMAC-SHA256 key for the session-cookie signature.
// All three are set as Workers secrets, not [vars]:
//   wrangler secret put PEOPLE_PASS_HASH   (etc.)
// Compute PEOPLE_PASS_HASH from a chosen salt + passphrase with:
//   node -e "crypto.subtle.digest('SHA-256',new TextEncoder().encode(process.argv[1]+process.argv[2])).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))" "<PEOPLE_SALT>" "<passphrase>"
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Internal push: productivity app notifies todo submission
    if (url.pathname === "/internal/todo-submitted" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { node_id, date } = await request.json();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO todo_events (node_id, date, submitted_at) VALUES (?, ?, ?)
         ON CONFLICT(node_id, date) DO UPDATE SET submitted_at = excluded.submitted_at`
      ).bind(node_id, date, now).run();
      return new Response("OK", { status: 200 });
    }

    // Internal push: the app links/unlinks a routine to this node. A flagged
    // node judges satisfied only if scanned AND its routine completed in the
    // window (2026-08-07 — a deliberate call, reversing the
    // presence-only simplification; routines replaced the to-do as the thing
    // worth gating on).
    if (url.pathname === "/internal/routine-config" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { node_id, required } = await request.json();
      await ensureRoutineTables(env);
      if (required) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO routine_required (node_id) VALUES (?)"
        ).bind(node_id).run();
      } else {
        await env.DB.prepare(
          "DELETE FROM routine_required WHERE node_id = ?"
        ).bind(node_id).run();
      }
      return new Response("OK", { status: 200 });
    }

    // Internal push: the app reports a routine run completed for the day.
    if (url.pathname === "/internal/routine-done" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { node_id, date } = await request.json();
      await ensureRoutineTables(env);
      await env.DB.prepare(
        `INSERT INTO routine_events (node_id, date, done_at) VALUES (?, ?, ?)
         ON CONFLICT(node_id, date) DO UPDATE SET done_at = excluded.done_at`
      ).bind(node_id, date, new Date().toISOString()).run();
      return new Response("OK", { status: 200 });
    }

    // Internal push: productivity app syncs todo content for the /todo page.
    // Last-writer-wins: if the stored row is newer (edited from the page),
    // reject with 409 and return the winning row so the app can adopt it.
    if (url.pathname === "/internal/todo-content" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { date, content, updated_at } = await request.json();
      await ensureTodoTable(env);
      const incoming = updated_at || new Date().toISOString();
      const existing = await env.DB.prepare(
        "SELECT * FROM todo_page WHERE date = ?"
      ).bind(date).first();
      if (existing && new Date(existing.updated_at) > new Date(incoming)) {
        return new Response(JSON.stringify(existing), {
          status: 409, headers: { "Content-Type": "application/json" },
        });
      }
      await env.DB.prepare(
        `INSERT INTO todo_page (date, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).bind(date, content || "", incoming).run();
      return new Response("OK", { status: 200 });
    }

    // Internal push: productivity app syncs the inbox blob (same LWW as todo)
    if (url.pathname === "/internal/inbox-content" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { content, updated_at } = await request.json();
      await ensureInboxTable(env);
      const incoming = updated_at || new Date().toISOString();
      const existing = await env.DB.prepare("SELECT * FROM inbox_page WHERE id = 1").first();
      if (existing && new Date(existing.updated_at) > new Date(incoming)) {
        return new Response(JSON.stringify(existing), {
          status: 409, headers: { "Content-Type": "application/json" },
        });
      }
      await env.DB.prepare(
        `INSERT INTO inbox_page (id, content, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).bind(content || "", incoming).run();
      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/internal/inbox-content" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureInboxTable(env);
      const row = await env.DB.prepare("SELECT * FROM inbox_page WHERE id = 1").first();
      return json(row || {});
    }

    // Internal pull: productivity app fetches the latest row to adopt page edits
    if (url.pathname === "/internal/todo-content" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureTodoTable(env);
      const row = await env.DB.prepare(
        "SELECT * FROM todo_page ORDER BY date DESC LIMIT 1"
      ).first();
      return json(row || {});
    }

    // Internal push: app syncs the people+interactions snapshot (LWW like todo)
    if (url.pathname === "/internal/people-snapshot" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { content, updated_at } = await request.json();
      await ensurePeopleTables(env);
      const incoming = updated_at || new Date().toISOString();
      const existing = await env.DB.prepare("SELECT * FROM people_snapshot WHERE id = 1").first();
      if (existing && new Date(existing.updated_at) > new Date(incoming)) {
        return new Response(JSON.stringify(existing), {
          status: 409, headers: { "Content-Type": "application/json" },
        });
      }
      await env.DB.prepare(
        `INSERT INTO people_snapshot (id, content, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).bind(content || "", incoming).run();
      return new Response("OK", { status: 200 });
    }

    // Internal pull: app fetches the phone-appended capture blob to merge
    if (url.pathname === "/internal/people-capture" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensurePeopleTables(env);
      const row = await env.DB.prepare("SELECT * FROM people_capture WHERE id = 1").first();
      return json(row || {});
    }

    // Internal overwrite: app CLEARS/replaces the capture blob after merging it.
    // Plain overwrite (not LWW): the app owns clearing; the phone only appends.
    if (url.pathname === "/internal/people-capture" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { content, updated_at } = await request.json();
      await ensurePeopleTables(env);
      const now = updated_at || new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO people_capture (id, content, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).bind(content || "", now).run();
      return new Response("OK", { status: 200 });
    }

    // Internal push: record the per-date crm outcome (SEPARATE from the sleep QR
    // outcome — the scan opens the fill window, this records whether it was met)
    if (url.pathname === "/internal/crm-outcome" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { date, satisfied } = await request.json();
      if (!date) return new Response("Missing date", { status: 400 });
      await ensurePeopleTables(env);
      await recordCrmOutcome(env, date, satisfied ? 1 : 0);
      return new Response("OK", { status: 200 });
    }

    // Internal push: which node opens the journal + this week's habit label.
    if (url.pathname === "/internal/journal-config" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureJournalTables(env);
      const { node_id, habit, habit_week_start } = await request.json();
      await env.DB.prepare(
        `INSERT INTO journal_config (id, node_id, habit, habit_week_start, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           node_id = excluded.node_id, habit = excluded.habit,
           habit_week_start = excluded.habit_week_start, updated_at = excluded.updated_at`
      ).bind(node_id ?? null, habit || "", habit_week_start || "", new Date().toISOString()).run();
      return new Response("OK", { status: 200 });
    }

    // Internal pull: all journal entries for the desktop mirror.
    if (url.pathname === "/internal/journal-entries" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureJournalTables(env);
      const { results } = await env.DB.prepare(
        `SELECT date, bottleneck, active_experiment, rating, habit_mark, updated_at
         FROM journal_entry ORDER BY date DESC`
      ).all();
      return json({ entries: results });
    }

    // Internal push: one desktop-edited row (last-write-wins by updated_at).
    if (url.pathname === "/internal/journal-entries" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureJournalTables(env);
      const e = await request.json();
      if (!e || !e.date) return new Response("Missing date", { status: 400 });
      await upsertJournalEntry(env, e);
      return new Response("OK", { status: 200 });
    }

    // Internal push: social-points catalog + staked floor + gated node id.
    if (url.pathname === "/internal/social-config" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureSocialTables(env);
      const { node_id, floor, actions } = await request.json();
      await env.DB.prepare(
        `INSERT INTO social_config (id, node_id, floor, actions, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, floor = excluded.floor,
           actions = excluded.actions, updated_at = excluded.updated_at`
      ).bind(node_id ?? null, floor ?? null, JSON.stringify(actions || []), new Date().toISOString()).run();
      return new Response("OK", { status: 200 });
    }

    // Internal push: the app's authoritative day total (desktop + pulled phone).
    if (url.pathname === "/internal/social-total" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureSocialTables(env);
      const { date, total } = await request.json();
      if (!date) return new Response("Missing date", { status: 400 });
      await env.DB.prepare(
        `INSERT INTO social_total (date, total, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET total = excluded.total, updated_at = excluded.updated_at`
      ).bind(date, total | 0, new Date().toISOString()).run();
      return new Response("OK", { status: 200 });
    }

    // Internal pull: app fetches the phone-appended capture ops to merge.
    if (url.pathname === "/internal/social-capture" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureSocialTables(env);
      const row = await env.DB.prepare("SELECT * FROM social_capture WHERE id = 1").first();
      return json(row || {});
    }

    // Internal overwrite: app CLEARS the capture blob after merging (like people).
    if (url.pathname === "/internal/social-capture" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.INTERNAL_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      await ensureSocialTables(env);
      const { content, updated_at } = await request.json();
      await env.DB.prepare(
        `INSERT INTO social_capture (id, content, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).bind(content || "", updated_at || new Date().toISOString()).run();
      return new Response("OK", { status: 200 });
    }

    // People CRM phone surface — passphrase-gated, HMAC-signed cookie session.
    // Read + append only: shows the app-pushed snapshot and appends capture ops;
    // it never edits or deletes existing notes (structural edits are desktop-only).
    if (url.pathname === "/people") {
      await ensurePeopleTables(env);
      // Fail closed: with any of the three secrets unset the HMAC key would be
      // the empty string (publicly reproducible → forgeable cookie), so refuse
      // to mint or accept sessions until they are configured.
      if (!peopleConfigured(env)) {
        return new Response("People CRM not configured", { status: 500 });
      }
      const authed = await verifyPeopleCookie(request, env);

      if (request.method === "POST") {
        // Authed session: an entry / new-person / nothing submission (JSON body)
        if (authed) {
          const op = await request.json().catch(() => null);
          if (!op || typeof op.op !== "string") {
            return new Response("Bad request", { status: 400 });
          }
          const now = new Date().toISOString();
          const today = localDateStr(new Date(), env.LOCAL_TZ || "UTC");
          let entry = null;
          if (op.op === "entry") {
            if (op.person_id == null || !op.note) {
              return new Response("person_id and note required", { status: 400 });
            }
            entry = {
              op: "entry", person_id: op.person_id, date: op.date || today,
              note: String(op.note), source: "phone", created_at: now,
            };
          } else if (op.op === "new_person") {
            if (!op.name) return new Response("name required", { status: 400 });
            entry = {
              op: "new_person", name: String(op.name),
              company: op.company || "", location: op.location || "",
              email: op.email || "", linkedin: op.linkedin || "",
              birthday: op.birthday || "", how_we_met: op.how_we_met || "",
              cadence: op.cadence || "none", next_action: op.next_action || "",
              buckets: Array.isArray(op.buckets) ? op.buckets : [],
              source: "phone", created_at: now,
            };
          } else if (op.op === "nothing") {
            entry = { op: "nothing", date: today, source: "phone", created_at: now };
          } else {
            return new Response("Unknown op", { status: 400 });
          }
          await appendCapture(env, entry);
          // A real entry, a new person, or an explicit "nothing" all satisfy the
          // night for today (same rule as POST /internal/crm-outcome).
          await recordCrmOutcome(env, today, 1);
          return json({ ok: true, recorded: today });
        }

        // Unauthed POST = a passphrase attempt (form-encoded).
        const form = await request.formData().catch(() => null);
        const passphrase = form ? (form.get("passphrase") || "") : "";
        const authRow = await env.DB.prepare("SELECT * FROM people_auth WHERE id = 1").first();
        const nowMs = Date.now();
        // Global lockout: while locked, reject regardless of correctness.
        if (authRow && authRow.locked_until
            && new Date(authRow.locked_until).getTime() > nowMs) {
          return new Response(renderPeopleLogin("Locked — too many attempts. Try again later."), {
            status: 429,
            headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
          });
        }
        const computed = await sha256Hex((env.PEOPLE_SALT || "") + String(passphrase));
        const ok = timingSafeEqualHex(computed, (env.PEOPLE_PASS_HASH || "").trim());
        if (ok) {
          // Reset the global fail counter and issue a signed session cookie.
          await env.DB.prepare(
            `INSERT INTO people_auth (id, fails, locked_until) VALUES (1, 0, NULL)
             ON CONFLICT(id) DO UPDATE SET fails = 0, locked_until = NULL`
          ).run();
          const cookie = await makePeopleCookie(env);
          return new Response(null, {
            status: 303, headers: { Location: "/people", "Set-Cookie": cookie },
          });
        }
        // Failed attempt: increment the global counter ATOMICALLY in SQL
        // (fails = fails + 1) so parallel attempts can't race past the cap via a
        // read-modify-write; then lock for an hour once the committed count
        // crosses the threshold.
        await env.DB.prepare(
          `INSERT INTO people_auth (id, fails, locked_until) VALUES (1, 1, NULL)
           ON CONFLICT(id) DO UPDATE SET fails = fails + 1`
        ).run();
        const bumped = await env.DB.prepare(
          "SELECT fails FROM people_auth WHERE id = 1"
        ).first();
        if (bumped && bumped.fails >= PEOPLE_MAX_FAILS) {
          await env.DB.prepare(
            "UPDATE people_auth SET locked_until = ? WHERE id = 1"
          ).bind(new Date(nowMs + PEOPLE_LOCK_MS).toISOString()).run();
        }
        return new Response(renderPeopleLogin("Incorrect passphrase."), {
          status: 401,
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        });
      }

      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!authed) {
        return new Response(renderPeopleLogin(null), {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        });
      }
      const snapRow = await env.DB.prepare("SELECT * FROM people_snapshot WHERE id = 1").first();
      const today = localDateStr(new Date(), env.LOCAL_TZ || "UTC");
      return new Response(renderPeoplePage(snapRow || { content: "", updated_at: null }, today), {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
      });
    }

    // Key-gated todo page
    const todoMatch = url.pathname.match(/^\/todo\/([A-Za-z0-9_-]+)$/);
    if (todoMatch) {
      const key = (env.TODO_VIEW_KEY || "").trim();
      if (!key || todoMatch[1] !== key) {
        return new Response("Not found", { status: 404 });
      }
      await ensureTodoTable(env);
      await ensureInboxTable(env);
      if (request.method === "POST") {
        const { date, content, inbox, submit } = await request.json();
        const now = new Date().toISOString();
        if (inbox) {
          await env.DB.prepare(
            `INSERT INTO inbox_page (id, content, updated_at) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
          ).bind(content || "", now).run();
          return json({ ok: true, updated_at: now });
        }
        // Submit the to-do for accountability: save the current content, then
        // record a todo_events row for today for every active requires_todo
        // node (mirrors the app's /internal/todo-submitted push). Always keyed
        // to the current local day so a stale open tab can't submit a past date.
        if (submit) {
          const submitDate = localDateStr(new Date(), env.LOCAL_TZ || "UTC");
          await env.DB.prepare(
            `INSERT INTO todo_page (date, content, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
          ).bind(submitDate, content || "", now).run();
          const { results: todoNodes } = await env.DB.prepare(
            "SELECT id FROM nodes WHERE active = 1 AND requires_todo = 1"
          ).all();
          for (const n of todoNodes) {
            await env.DB.prepare(
              `INSERT INTO todo_events (node_id, date, submitted_at) VALUES (?, ?, ?)
               ON CONFLICT(node_id, date) DO UPDATE SET submitted_at = excluded.submitted_at`
            ).bind(n.id, submitDate, now).run();
          }
          return json({ ok: true, date: submitDate, submitted_at: now, nodes: todoNodes.length });
        }
        if (!date) return new Response("Missing date", { status: 400 });
        await env.DB.prepare(
          `INSERT INTO todo_page (date, content, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
        ).bind(date, content || "", now).run();
        return json({ ok: true, date, updated_at: now });
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      // Always edit the current day (LOCAL_TZ), even before the app pushes it
      const today = localDateStr(new Date(), env.LOCAL_TZ || "UTC");
      const row = await env.DB.prepare(
        "SELECT * FROM todo_page WHERE date = ?"
      ).bind(today).first();
      const inboxRow = await env.DB.prepare("SELECT * FROM inbox_page WHERE id = 1").first();
      // Today's accountability submission status across all active to-do nodes
      const { results: todoNodes } = await env.DB.prepare(
        "SELECT id FROM nodes WHERE active = 1 AND requires_todo = 1"
      ).all();
      const { results: submittedRows } = await env.DB.prepare(
        "SELECT node_id, submitted_at FROM todo_events WHERE date = ?"
      ).bind(today).all();
      const submittedIds = new Set(submittedRows.map((r) => r.node_id));
      const submitInfo = {
        required: todoNodes.length,
        submitted: todoNodes.filter((n) => submittedIds.has(n.id)).length,
        submitted_at: submittedRows
          .filter((r) => todoNodes.some((n) => n.id === r.node_id))
          .map((r) => r.submitted_at)
          .sort()
          .pop() || null,
      };
      return new Response(renderTodoPage(
        row || { date: today, content: "", updated_at: null },
        inboxRow || { content: "", updated_at: null },
        submitInfo
      ), {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
      });
    }

    // Journal phone surface — the sleep-QR nightly fill. Passphrase-gated,
    // reusing the People session cookie + lockout (one shared "phone passphrase").
    if (url.pathname === "/journal") {
      await ensureJournalTables(env);
      await ensurePeopleTables(env);
      if (!peopleConfigured(env)) {
        return new Response("Journal not configured — set the phone passphrase secrets.", { status: 500 });
      }
      const authed = await verifyPeopleCookie(request, env);
      const tz = env.LOCAL_TZ || "UTC";
      const today = localDateStr(new Date(), tz);
      const tomorrow = datePlusDays(today, 1);

      if (request.method === "POST") {
        // Authed: a save. Today's row gets rating + habit mark; tomorrow's row
        // gets the bottleneck + experiment (written the night before).
        if (authed) {
          const body = await request.json().catch(() => null);
          if (!body || body.op !== "save") return new Response("Bad request", { status: 400 });
          let rating = body.rating;
          rating = rating === "" || rating == null ? null : Number(rating);
          if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 7)) {
            return new Response("rating must be 1-7", { status: 400 });
          }
          let mark = body.habit_mark;
          if (mark === "" || mark == null) mark = null;
          if (mark != null && !["ehh", "good", "great"].includes(mark)) {
            return new Response("bad habit_mark", { status: 400 });
          }
          await saveJournalFromPhone(env, {
            today, tomorrow, rating, habit_mark: mark,
            bottleneck: String(body.bottleneck || ""),
            active_experiment: String(body.active_experiment || ""),
          });
          return json({ ok: true });
        }

        // Unauthed POST = passphrase attempt (form-encoded), same global lockout
        // as /people (shared people_auth row).
        const form = await request.formData().catch(() => null);
        const passphrase = form ? (form.get("passphrase") || "") : "";
        const authRow = await env.DB.prepare("SELECT * FROM people_auth WHERE id = 1").first();
        const nowMs = Date.now();
        if (authRow && authRow.locked_until && new Date(authRow.locked_until).getTime() > nowMs) {
          return new Response(renderJournalLogin("Locked — too many attempts. Try again later."), {
            status: 429, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
          });
        }
        const computed = await sha256Hex((env.PEOPLE_SALT || "") + String(passphrase));
        const ok = timingSafeEqualHex(computed, (env.PEOPLE_PASS_HASH || "").trim());
        if (ok) {
          await env.DB.prepare(
            `INSERT INTO people_auth (id, fails, locked_until) VALUES (1, 0, NULL)
             ON CONFLICT(id) DO UPDATE SET fails = 0, locked_until = NULL`
          ).run();
          const cookie = await makePeopleCookie(env);
          return new Response(null, {
            status: 303, headers: { Location: "/journal", "Set-Cookie": cookie },
          });
        }
        await env.DB.prepare(
          `INSERT INTO people_auth (id, fails, locked_until) VALUES (1, 1, NULL)
           ON CONFLICT(id) DO UPDATE SET fails = fails + 1`
        ).run();
        const bumped = await env.DB.prepare("SELECT fails FROM people_auth WHERE id = 1").first();
        if (bumped && bumped.fails >= PEOPLE_MAX_FAILS) {
          await env.DB.prepare("UPDATE people_auth SET locked_until = ? WHERE id = 1")
            .bind(new Date(nowMs + PEOPLE_LOCK_MS).toISOString()).run();
        }
        return new Response(renderJournalLogin("Incorrect passphrase."), {
          status: 401, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        });
      }

      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!authed) {
        return new Response(renderJournalLogin(null), {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        });
      }
      const cfg = await env.DB.prepare("SELECT * FROM journal_config WHERE id = 1").first();
      const todayRow = await env.DB.prepare("SELECT * FROM journal_entry WHERE date = ?").bind(today).first();
      const tomRow = await env.DB.prepare("SELECT * FROM journal_entry WHERE date = ?").bind(tomorrow).first();
      return new Response(renderJournalPage({
        today, tomorrow, habit: cfg ? cfg.habit : "",
        todayRow: todayRow || {}, tomRow: tomRow || {},
        fromScan: url.searchParams.get("from") === "scan",
      }), { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
    }

    // Social quick-log phone surface — same view key as /todo (NOT the people
    // passphrase path). Taps append a capture op the app pulls; shows the day
    // total vs the staked floor.
    const socialMatch = url.pathname.match(/^\/social\/([A-Za-z0-9_-]+)$/);
    if (socialMatch) {
      const key = (env.TODO_VIEW_KEY || "").trim();
      if (!key || socialMatch[1] !== key) return new Response("Not found", { status: 404 });
      await ensureSocialTables(env);
      const tz = env.LOCAL_TZ || "UTC";
      const today = localDateStr(new Date(), tz);
      const cfg = await env.DB.prepare("SELECT * FROM social_config WHERE id = 1").first();
      const actions = cfg && cfg.actions ? JSON.parse(cfg.actions) : [];
      const floor = cfg && cfg.floor != null ? cfg.floor : null;

      if (request.method === "POST") {
        const { action_id } = await request.json();
        const action = actions.find((a) => String(a.id) === String(action_id));
        if (!action) return new Response("Unknown action", { status: 400 });
        const row = await env.DB.prepare("SELECT * FROM social_capture WHERE id = 1").first();
        let ops = [];
        if (row && row.content) { try { ops = JSON.parse(row.content); } catch (e) { ops = []; } }
        ops.push({ action_id: action.id, points: action.points, date: today, ts: new Date().toISOString() });
        await env.DB.prepare(
          `INSERT INTO social_capture (id, content, updated_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
        ).bind(JSON.stringify(ops), new Date().toISOString()).run();
        return json({ ok: true, total: await socialTotalFor(env, today), floor });
      }
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return new Response(renderSocialPage(actions, await socialTotalFor(env, today), floor, today), {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
      });
    }

    // Admin API
    if (url.pathname.startsWith("/admin/")) {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${(env.ADMIN_SECRET || "").trim()}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return handleAdmin(request, url, env);
    }

    // QR scan page
    const match = url.pathname.match(/^\/scan\/([A-Za-z0-9_-]+)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const token = match[1];

    const node = await env.DB.prepare(
      "SELECT * FROM nodes WHERE token = ? AND active = 1"
    ).bind(token).first();
    if (!node) return new Response("Unknown or inactive node", { status: 404 });

    if (request.method === "GET") {
      // The journal node hands off to the nightly fill form after the scan logs.
      await ensureJournalTables(env);
      const jcfg = await env.DB.prepare("SELECT node_id FROM journal_config WHERE id = 1").first();
      const isJournal = jcfg && jcfg.node_id != null && String(jcfg.node_id) === String(node.id);
      return new Response(renderScanPage(node, isJournal), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (request.method === "POST") {
      await ensureScanColumns(env);
      const body = await request.json();
      const { lat, lng, accuracy } = body;

      let geofencePass = null;
      let dist = null;
      if (node.geofence_lat != null) {
        dist = Math.round(haversineMeters(lat, lng, node.geofence_lat, node.geofence_lng));
        geofencePass = dist <= node.geofence_radius_m ? 1 : 0;
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO scan_events (node_id, scanned_at, lat, lng, geofence_pass, accuracy_m)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(node.id, now, lat ?? null, lng ?? null, geofencePass, accuracy ?? null).run();

      let msg = "Logged.";
      if (geofencePass === 1) {
        msg = "Logged — within range.";
      } else if (geofencePass === 0) {
        msg = Number.isFinite(dist)
          ? `Logged — OUT OF RANGE: ${dist}m from the target (limit ${node.geofence_radius_m}m). Re-scan to try again.`
          : "Logged — no location captured, so this scan cannot satisfy the geofence. Re-scan with location on.";
      }
      return new Response(msg, { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },

  async scheduled(controller, env, ctx) {
    await ensureDaysColumn(env);
    await ensureSocialTables(env);
    const tz = env.LOCAL_TZ || "UTC";
    const now = new Date();
    const localDate = localDateStr(now, tz);

    // Apply any pending loosening changes whose delay has elapsed
    const { results: pending } = await env.DB.prepare(
      "SELECT * FROM pending_changes WHERE apply_at <= ?"
    ).bind(now.toISOString()).all();

    for (const change of pending) {
      await env.DB.prepare(
        `UPDATE nodes SET ${change.field} = ? WHERE id = ?`
      ).bind(change.new_value, change.node_id).run();
      await env.DB.prepare("DELETE FROM pending_changes WHERE id = ?").bind(change.id).run();
    }

    const { results: nodes } = await env.DB.prepare(
      "SELECT * FROM nodes WHERE active = 1"
    ).all();

    const summaryLines = [];

    for (const node of nodes) {
      // Each window is keyed by its START date. Evaluate yesterday's window as
      // well as today's: a window with window_end_offset_days = 1 (past-midnight
      // deadline) closes on the day AFTER its date, so it can only ever be
      // judged on the following tick-day. This also backfills a single missed
      // day if the cron was down at close time.
      for (const windowDate of [datePlusDays(localDate, -1), localDate]) {
        // Skip days the node doesn't apply to (days_of_week digits, 0=Mon..6=Sun)
        if (node.days_of_week != null && !String(node.days_of_week).includes(dowOf(windowDate))) continue;

        // Resolve effective config: date override > weekly window > node defaults
        const override = await env.DB.prepare(
          "SELECT * FROM node_overrides WHERE node_id = ? AND date = ?"
        ).bind(node.id, windowDate).first();
        const weekly = weeklyWindowFor(node, windowDate);

        const windowStart = override ? override.window_start : weekly ? weekly.window_start : node.window_start;
        const windowEnd = override ? override.window_end : weekly ? weekly.window_end : node.window_end;
        const offsetDays = override ? override.window_end_offset_days
          : weekly ? (weekly.window_end_offset_days || 0) : node.window_end_offset_days;

        // Determine the effective closing date/time
        const windowCloseDate = offsetDays === 1 ? datePlusDays(windowDate, 1) : windowDate;
        const windowOpenISO = localDateTimeToISO(windowDate, windowStart, tz);
        const windowCloseISO = localDateTimeToISO(windowCloseDate, windowEnd, tz);

        // The daily to-do list was retired (2026-08), so nothing gates on it
        // any more: a node is judged the moment its window closes, and
        // PRESENCE (plus geofence, plus the social floor where configured) is
        // the whole test. requires_todo / todo_grace_minutes are dead columns
        // — deliberately left in the schema, but never read for judgment.
        const judgeAtMs = new Date(windowCloseISO).getTime();
        if (now.getTime() < judgeAtMs) continue;

        const existing = await env.DB.prepare(
          "SELECT 1 FROM charge_log WHERE node_id = ? AND date = ?"
        ).bind(node.id, windowDate).first();
        if (existing) continue;

        const { results: scans } = await env.DB.prepare(
          `SELECT * FROM scan_events
           WHERE node_id = ? AND scanned_at >= ? AND scanned_at <= ?
           ORDER BY scanned_at DESC`
        ).bind(node.id, windowOpenISO, windowCloseISO).all();

        const satisfyingScan = scans.find(
          (s) => node.geofence_lat == null || s.geofence_pass === 1
        );

        let failureReason = null;
        if (!satisfyingScan) {
          failureReason = "absent";
        }

        // Social floor: if this is the social-gated node, the day's social
        // points must clear the staked floor (present but under floor -> charge).
        if (!failureReason && satisfyingScan) {
          const scfg = await env.DB.prepare(
            "SELECT node_id, floor FROM social_config WHERE id = 1"
          ).first();
          if (scfg && scfg.node_id != null && String(scfg.node_id) === String(node.id) && scfg.floor != null) {
            if (await socialTotalFor(env, windowDate) < scfg.floor) {
              failureReason = "under_social_floor";
            }
          }
        }

        // Routine gate (2026-08-07): a node the app flagged via
        // /internal/routine-config is satisfied only if its routine run
        // completed for the window's date. Present but routine-undone fails —
        // the deliberate reversal of the presence-only rule, with routines
        // (not the retired to-do) as the thing worth gating on.
        if (!failureReason && satisfyingScan) {
          await ensureRoutineTables(env);
          const rreq = await env.DB.prepare(
            "SELECT 1 FROM routine_required WHERE node_id = ?"
          ).bind(node.id).first();
          if (rreq) {
            const rdone = await env.DB.prepare(
              "SELECT 1 FROM routine_events WHERE node_id = ? AND date = ?"
            ).bind(node.id, windowDate).first();
            if (!rdone) failureReason = "routine_incomplete";
          }
        }

        const dateTag = windowDate === localDate ? "" : ` (${windowDate})`;
        if (!failureReason) {
          summaryLines.push(`✓ ${node.label}${dateTag}: satisfied`);
          continue;
        }

        let chargeStatus = "would_fire";
        let paymentIntentId = null;

        // The stake is per FAILURE REASON, not per node. Missing the social floor
        // is the expensive one; an absent scan or a missing to-do keeps the base
        // amount. Both numbers live in wrangler vars, and the social fallback
        // equals its var so a missing var can't silently change the price.
        // charge_log stores failure_reason, so which amount fired stays
        // reconstructable from the log without a new column.
        const amountCents = failureReason === "under_social_floor"
          ? (env.SOCIAL_CHARGE_AMOUNT_CENTS || "800")
          : (env.CHARGE_AMOUNT_CENTS || "1000");

        await ensureChargeColumns(env);
        const capCents = Number(env.WEEKLY_CHARGE_CAP_CENTS || "2500");
        const spent = await weeklySpentCents(env, windowDate);
        const live = env.LIVE_CHARGING === "true";
        if (live && spent + Number(amountCents) > capCents) chargeStatus = "capped";
        const willCharge = live && chargeStatus !== "capped";

        // RESERVE BEFORE CHARGING. The charge_log row is the only thing that
        // stops the next tick, so it has to exist BEFORE money can move.
        // Charging first and logging after leaves a window where a lost
        // response (fetch throws, worker evicted, D1 hiccup) means the money
        // moved and no row was written — and the 5-minute cron then charges
        // again, and again, and again. UNIQUE(node_id, date) makes the
        // reservation atomic: a second tick's INSERT is ignored, so it backs
        // off here instead of duplicating the charge.
        const reserved = await env.DB.prepare(
          `INSERT OR IGNORE INTO charge_log (node_id, date, failure_reason, charge_status,
                                             stripe_payment_intent_id, amount_cents)
           VALUES (?, ?, ?, ?, NULL, ?)`
        ).bind(node.id, windowDate, failureReason,
               willCharge ? "charging" : chargeStatus,
               willCharge ? Number(amountCents) : null).run();
        // Skip only on a KNOWN-ignored insert. If a D1 version ever stops
        // reporting changes, fall through to today's behaviour (the `existing`
        // SELECT above is still the guard) rather than silently never charging.
        if (reserved.meta?.changes === 0) continue;

        if (willCharge) {
          const r = await beeminderCharge(
            env, amountCents, `${node.label}: ${failureReason} on ${windowDate}`
          );
          chargeStatus = r.status;
          paymentIntentId = r.id;
          await env.DB.prepare(
            `UPDATE charge_log SET charge_status = ?, stripe_payment_intent_id = ?, amount_cents = ?
             WHERE node_id = ? AND date = ?`
          ).bind(chargeStatus, paymentIntentId,
                 chargeStatus === "failed" ? null : Number(amountCents),
                 node.id, windowDate).run();
        }

        summaryLines.push(
          `✗ ${node.label}${dateTag}: ${failureReason} → ${chargeStatus}` +
          (chargeStatus === "capped"
            ? ` (weekly cap $${(capCents / 100).toFixed(2)} reached)` : "")
        );
      }
    }

    // Daily summary email — only send if at least one node was evaluated
    if (summaryLines.length > 0 && env.SUMMARY_EMAIL_TO) {
      await sendSummaryEmail(env, localDate, summaryLines);
    }
  },
};

async function ensureSocialTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS social_config (
       id INTEGER PRIMARY KEY, node_id INTEGER, floor INTEGER, actions TEXT, updated_at TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS social_total (
       date TEXT PRIMARY KEY, total INTEGER, updated_at TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS social_capture (
       id INTEGER PRIMARY KEY, content TEXT, updated_at TEXT)`
  ).run();
}

// Authoritative day total = the app-pushed desktop total + any un-pulled phone
// ops for that date. When the app pulls & clears the capture it re-pushes the
// higher desktop total, so this never double-counts.
async function socialTotalFor(env, date) {
  const totalRow = await env.DB.prepare(
    "SELECT total FROM social_total WHERE date = ?"
  ).bind(date).first();
  let total = totalRow ? (totalRow.total | 0) : 0;
  const capRow = await env.DB.prepare("SELECT content FROM social_capture WHERE id = 1").first();
  if (capRow && capRow.content) {
    try {
      for (const op of JSON.parse(capRow.content)) {
        if (op && op.date === date) total += (op.points | 0);
      }
    } catch (e) {}
  }
  return total;
}

function renderSocialPage(actions, total, floor, today) {
  const cats = [["responsive", "Responsive"], ["initiating", "Initiating"],
                ["depth", "Depth"], ["broadcast", "Broadcast"],
                ["structural", "Structural ×1.5"]];
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const groups = cats.map(([cat, label]) => {
    const items = actions.filter((a) => a.category === cat);
    if (!items.length) return "";
    const chips = items.map((a) =>
      `<button class="chip" data-id="${a.id}"><span>${a.initiation ? "● " : ""}${esc(a.label)}</span><b>${a.points}</b></button>`
    ).join("");
    return `<div class="cat">${label}</div>${chips}`;
  }).join("");
  const met = floor != null && total >= floor;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Social log</title><style>
:root{color-scheme:light}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#f7f7f8;color:#1a1a1a;padding:16px;max-width:520px;margin:0 auto}
.score{text-align:center;padding:18px;background:#fff;border:1px solid #e2e2e5;border-radius:12px;margin-bottom:8px}
.score .n{font-size:40px;font-weight:700}.score .n span{color:#aaa;font-size:22px}
.score.met .n{color:#2e8b57}.score .cap{color:#888;font-size:13px;text-transform:uppercase;letter-spacing:.05em;margin-top:4px}
.cat{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin:16px 4px 6px}
.chip{width:100%;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 16px;margin-bottom:8px;background:#fff;border:1px solid #e2e2e5;border-radius:10px;font-size:16px;color:#1a1a1a;text-align:left}
.chip:active{background:#eef}.chip b{color:#3b6fd4}.chip.done{opacity:.45}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:20px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
</style></head><body>
<div class="score${met ? " met" : ""}" id="score">
  <div class="n" id="total">${total}<span>/${floor == null ? "—" : floor}</span></div>
  <div class="cap">${met ? "floor cleared" : "points today"} · ${today}</div>
</div>
${groups}
<div id="toast"></div>
<script>
var toast=document.getElementById('toast');
function showToast(t){toast.textContent=t;toast.classList.add('show');setTimeout(function(){toast.classList.remove('show')},1200)}
document.querySelectorAll('.chip').forEach(function(b){b.addEventListener('click',function(){
  b.classList.add('done');
  fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action_id:Number(b.dataset.id)})})
   .then(function(r){return r.json()}).then(function(j){
     if(j.ok){
       document.getElementById('total').innerHTML=j.total+'<span>/'+(j.floor==null?'—':j.floor)+'</span>';
       if(j.floor!=null&&j.total>=j.floor)document.getElementById('score').classList.add('met');
       showToast('+'+b.querySelector('b').textContent+' logged');
     }else{showToast('failed')}
   }).catch(function(){showToast('failed')});
  setTimeout(function(){b.classList.remove('done')},400);
})});
</script></body></html>`;
}

async function handleAdmin(request, url, env) {
  await ensureDaysColumn(env);

  // GET /admin/charge-log — recent evaluation history, read-only
  if (url.pathname === "/admin/charge-log" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM charge_log ORDER BY date DESC, node_id LIMIT 60"
    ).all();
    return json(results);
  }

  // GET /admin/outcomes?from=YYYY-MM-DD&to=YYYY-MM-DD — per-node daily results
  // for closed windows only: 'failed' if a charge_log row exists or no
  // satisfying scan is found, 'success' otherwise. Open windows are
  // omitted. Mirrors the scheduled handler's resolution and judgment logic.
  if (url.pathname === "/admin/outcomes" && request.method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    if (!isDate(from) || !isDate(to) || from > to || datePlusDays(from, 62) < to) {
      return new Response("from and to required (YYYY-MM-DD, max 62 days)", { status: 400 });
    }
    const tz = env.LOCAL_TZ || "UTC";
    const now = new Date();

    const { results: nodes } = await env.DB.prepare("SELECT * FROM nodes WHERE active = 1").all();
    const { results: charges } = await env.DB.prepare(
      "SELECT node_id, date FROM charge_log WHERE date >= ? AND date <= ?"
    ).bind(from, to).all();
    const { results: overrides } = await env.DB.prepare(
      "SELECT * FROM node_overrides WHERE date >= ? AND date <= ?"
    ).bind(from, to).all();
    // A +1d window starting on `to` can close as late as the end of to+1
    const { results: scans } = await env.DB.prepare(
      "SELECT node_id, scanned_at, geofence_pass FROM scan_events WHERE scanned_at >= ? AND scanned_at <= ?"
    ).bind(
      localDateTimeToISO(from, "00:00", tz),
      localDateTimeToISO(datePlusDays(to, 2), "00:00", tz)
    ).all();

    const outcomes = [];
    for (const node of nodes) {
      for (let d = from; d <= to; d = datePlusDays(d, 1)) {
        if (node.days_of_week != null && !String(node.days_of_week).includes(dowOf(d))) continue;
        const ov = overrides.find((o) => o.node_id === node.id && o.date === d);
        const weekly = weeklyWindowFor(node, d);
        const windowStart = ov ? ov.window_start : weekly ? weekly.window_start : node.window_start;
        const windowEnd = ov ? ov.window_end : weekly ? weekly.window_end : node.window_end;
        const offsetDays = ov ? ov.window_end_offset_days
          : weekly ? (weekly.window_end_offset_days || 0) : node.window_end_offset_days;
        const closeDate = offsetDays === 1 ? datePlusDays(d, 1) : d;
        const openISO = localDateTimeToISO(d, windowStart, tz);
        const closeISO = localDateTimeToISO(closeDate, windowEnd, tz);
        // Matches the scheduled handler: judged at window close, no to-do grace.
        if (now.getTime() < new Date(closeISO).getTime()) continue;

        if (charges.some((c) => c.node_id === node.id && c.date === d)) {
          outcomes.push({ node_id: node.id, date: d, outcome: "failed" });
          continue;
        }
        const satisfied = scans.some(
          (s) => s.node_id === node.id && s.scanned_at >= openISO && s.scanned_at <= closeISO
            && (node.geofence_lat == null || s.geofence_pass === 1)
        );
        outcomes.push({
          node_id: node.id, date: d,
          outcome: satisfied ? "success" : "failed",
        });
      }
    }
    return json(outcomes);
  }

  // GET /admin/scan-log — recent scan attempts with distance vs the node's
  // geofence (computed at read time so history is diagnosable too)
  if (url.pathname === "/admin/scan-log" && request.method === "GET") {
    const { results: nodes } = await env.DB.prepare(
      "SELECT id, geofence_lat, geofence_lng, geofence_radius_m FROM nodes"
    ).all();
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const { results } = await env.DB.prepare(
      "SELECT * FROM scan_events ORDER BY scanned_at DESC LIMIT 60"
    ).all();
    return json(results.map((s) => {
      const n = byId[s.node_id];
      const dist = s.lat != null && n && n.geofence_lat != null
        ? Math.round(haversineMeters(s.lat, s.lng, n.geofence_lat, n.geofence_lng))
        : null;
      return {
        id: s.id, node_id: s.node_id, scanned_at: s.scanned_at,
        geofence_pass: s.geofence_pass, has_coords: s.lat != null ? 1 : 0,
        accuracy_m: s.accuracy_m ?? null, distance_m: dist,
        radius_m: n ? n.geofence_radius_m : null,
      };
    }));
  }

  // POST /admin/email/test — send one summary email now to verify Resend setup
  if (url.pathname === "/admin/email/test" && request.method === "POST") {
    const today = localDateStr(new Date(), env.LOCAL_TZ || "UTC");
    const result = await sendSummaryEmail(env, today, ["test: email pipeline check"]);
    return json(result);
  }

  // GET /admin/billing/status — read-only: is charging wired up, and what did
  // it do lately. Creates nothing, charges nothing.
  if (url.pathname === "/admin/billing/status" && request.method === "GET") {
    await ensureChargeColumns(env);
    const { results: recent } = await env.DB.prepare(
      `SELECT node_id, date, failure_reason, charge_status, stripe_payment_intent_id AS charge_id
       FROM charge_log ORDER BY date DESC LIMIT 5`
    ).all();
    return json({
      provider: "beeminder",
      token_set: !!env.BEEMINDER_AUTH_TOKEN,
      user: env.BEEMINDER_USER || null,
      live_charging: env.LIVE_CHARGING === "true",
      dryrun: env.CHARGE_DRYRUN === "true",
      amount_cents: env.CHARGE_AMOUNT_CENTS || "1000",
      social_amount_cents: env.SOCIAL_CHARGE_AMOUNT_CENTS || "800",
      weekly_cap_cents: Number(env.WEEKLY_CHARGE_CAP_CENTS || "2500"),
      weekly_spent_cents: await weeklySpentCents(env, localDateStr(new Date(), env.LOCAL_TZ || "UTC")),
      recent_charges: recent,
    });
  }

  // POST /admin/billing/test-charge — fire one charge to verify the pipeline
  // end to end. DRY BY DEFAULT: pass ?live=1 to actually move money.
  //
  // It used to be the other way round (?dryrun=1 to stay safe), which made the
  // SAFE call the one you had to remember to type — on an endpoint that is
  // unlogged, ignores LIVE_CHARGING, and skipped the weekly cap. Debugging a
  // broken charge call against it therefore billed real money on every retry,
  // with nothing in charge_log to show for it. A test endpoint must default to
  // not spending money; the weekly cap now bounds it even when it does.
  if (url.pathname === "/admin/billing/test-charge" && request.method === "POST") {
    const live = url.searchParams.get("live") === "1";
    const amount = env.CHARGE_AMOUNT_CENTS || "1000";
    if (live) {
      await ensureChargeColumns(env);
      const capCents = Number(env.WEEKLY_CHARGE_CAP_CENTS || "2500");
      const spent = await weeklySpentCents(env, localDateStr(new Date(), env.LOCAL_TZ || "UTC"));
      if (spent + Number(amount) > capCents) {
        return json({ ok: false, status: "capped", amount, dryrun: false,
                      spent_cents: spent, cap_cents: capCents });
      }
    }
    const r = await beeminderCharge(
      live ? env : { ...env, CHARGE_DRYRUN: "true" }, amount, "Accountability test charge"
    );
    return json({ ok: r.status !== "failed", amount, dryrun: !live, ...r });
  }

  const nodeMatch = url.pathname.match(/^\/admin\/nodes\/(\d+)(\/.*)?$/);

  // GET /admin/nodes — list all nodes with pending changes and today's override
  if (url.pathname === "/admin/nodes" && request.method === "GET") {
    const tz = env.LOCAL_TZ || "UTC";
    const today = localDateStr(new Date(), tz);

    const { results: nodes } = await env.DB.prepare("SELECT * FROM nodes").all();
    const { results: pendingAll } = await env.DB.prepare("SELECT * FROM pending_changes").all();
    const { results: overridesAll } = await env.DB.prepare(
      "SELECT * FROM node_overrides WHERE date = ?"
    ).bind(today).all();

    const enriched = nodes.map((n) => ({
      ...n,
      pending_changes: pendingAll.filter((p) => p.node_id === n.id),
      today_override: overridesAll.find((o) => o.node_id === n.id) || null,
    }));

    return json(enriched);
  }

  // POST /admin/nodes — create a new node
  if (url.pathname === "/admin/nodes" && request.method === "POST") {
    const {
      label, window_start, window_end, window_end_offset_days = 0,
      geofence_lat, geofence_lng, geofence_radius_m, requires_todo = 0,
      days_of_week = "0123456", todo_grace_minutes = 0,
    } = await request.json();
    const token = generateToken();
    const result = await env.DB.prepare(
      `INSERT INTO nodes (label, token, window_start, window_end, window_end_offset_days,
         geofence_lat, geofence_lng, geofence_radius_m, requires_todo, days_of_week, todo_grace_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      label, token, window_start, window_end, window_end_offset_days,
      geofence_lat ?? null, geofence_lng ?? null, geofence_radius_m ?? null, requires_todo,
      days_of_week, todo_grace_minutes
    ).run();
    const newNode = await env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
      .bind(result.meta.last_row_id).first();
    return new Response(JSON.stringify(newNode), {
      status: 201, headers: { "Content-Type": "application/json" },
    });
  }

  if (!nodeMatch) return new Response("Not found", { status: 404 });
  const nodeId = parseInt(nodeMatch[1]);
  const subpath = nodeMatch[2] || "";

  // PATCH /admin/nodes/:id — edit node defaults (tighten=immediate, loosen=pending)
  if (subpath === "" && request.method === "PATCH") {
    const node = await env.DB.prepare("SELECT * FROM nodes WHERE id = ?").bind(nodeId).first();
    if (!node) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const immediateFields = [];
    const pendingFields = [];
    const applyAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    for (const [field, newVal] of Object.entries(body)) {
      if (!EDITABLE_FIELDS.includes(field)) continue;
      if (isLoosening(field, node[field], newVal, node)) {
        pendingFields.push({ field, newVal });
      } else {
        immediateFields.push({ field, newVal });
      }
    }

    for (const { field, newVal } of immediateFields) {
      await env.DB.prepare(`UPDATE nodes SET ${field} = ? WHERE id = ?`).bind(newVal, nodeId).run();
    }
    for (const { field, newVal } of pendingFields) {
      await env.DB.prepare(
        "INSERT INTO pending_changes (node_id, field, new_value, apply_at) VALUES (?, ?, ?, ?)"
      ).bind(nodeId, field, String(newVal), applyAt).run();
    }

    return json({ immediate: immediateFields, pending: pendingFields, apply_at: applyAt });
  }

  // POST /admin/nodes/:id/overrides — create one-day override
  if (subpath === "/overrides" && request.method === "POST") {
    const { date, window_start, window_end, window_end_offset_days = 0 } = await request.json();
    if (await overrideLocked(env, nodeId, date)) {
      return new Response("Locked — deadline within 24h", { status: 403 });
    }
    await env.DB.prepare(
      `INSERT INTO node_overrides (node_id, date, window_start, window_end, window_end_offset_days)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id, date) DO UPDATE SET
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         window_end_offset_days = excluded.window_end_offset_days`
    ).bind(nodeId, date, window_start, window_end, window_end_offset_days).run();
    return json({ ok: true });
  }

  // DELETE /admin/nodes/:id/overrides/:date — remove a one-day override
  const overrideMatch = subpath.match(/^\/overrides\/(\d{4}-\d{2}-\d{2})$/);
  if (overrideMatch && request.method === "DELETE") {
    if (await overrideLocked(env, nodeId, overrideMatch[1])) {
      return new Response("Locked — deadline within 24h", { status: 403 });
    }
    await env.DB.prepare(
      "DELETE FROM node_overrides WHERE node_id = ? AND date = ?"
    ).bind(nodeId, overrideMatch[1]).run();
    return json({ ok: true });
  }

  // PATCH /admin/nodes/:id/disable — schedule disable with 24h delay
  if (subpath === "/disable" && request.method === "PATCH") {
    const applyAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO pending_changes (node_id, field, new_value, apply_at) VALUES (?, 'active', '0', ?)"
    ).bind(nodeId, applyAt).run();
    return json({ pending: true, apply_at: applyAt });
  }

  // PATCH /admin/nodes/:id/activate — cancel a pending disable within its 24h window
  if (subpath === "/activate" && request.method === "PATCH") {
    const result = await env.DB.prepare(
      "DELETE FROM pending_changes WHERE node_id = ? AND field = 'active' AND new_value = '0'"
    ).bind(nodeId).run();
    if (!result.meta.changes) return new Response("No pending disable to cancel", { status: 409 });
    return json({ ok: true });
  }

  // DELETE /admin/nodes/:id — permanent delete, only after the node is inactive
  if (subpath === "" && request.method === "DELETE") {
    const node = await env.DB.prepare("SELECT * FROM nodes WHERE id = ?").bind(nodeId).first();
    if (!node) return new Response("Not found", { status: 404 });
    if (node.active) return new Response("Node still active — deactivate first", { status: 409 });
    // Event/log rows reference nodes(id); D1 enforces the FKs, so clear them first
    await env.DB.prepare("DELETE FROM scan_events WHERE node_id = ?").bind(nodeId).run();
    await env.DB.prepare("DELETE FROM todo_events WHERE node_id = ?").bind(nodeId).run();
    await env.DB.prepare("DELETE FROM charge_log WHERE node_id = ?").bind(nodeId).run();
    await env.DB.prepare("DELETE FROM node_overrides WHERE node_id = ?").bind(nodeId).run();
    await env.DB.prepare("DELETE FROM pending_changes WHERE node_id = ?").bind(nodeId).run();
    await env.DB.prepare("DELETE FROM nodes WHERE id = ?").bind(nodeId).run();
    return json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

// Fields that can be edited via the admin API
// (geofence_lat/lng: relocating is neither tighten nor loosen — always immediate)
const EDITABLE_FIELDS = [
  "window_start", "window_end", "window_end_offset_days",
  "geofence_lat", "geofence_lng", "geofence_radius_m", "requires_todo",
  "days_of_week", "weekly_windows", "todo_grace_minutes",
];

// A day's deadline is locked once its effective close is within 24h:
// overrides for that day can no longer be created, changed, or removed
async function overrideLocked(env, nodeId, date) {
  const node = await env.DB.prepare("SELECT * FROM nodes WHERE id = ?").bind(nodeId).first();
  if (!node) return false;
  const existing = await env.DB.prepare(
    "SELECT * FROM node_overrides WHERE node_id = ? AND date = ?"
  ).bind(nodeId, date).first();
  const weekly = weeklyWindowFor(node, date);
  const windowEnd = existing ? existing.window_end : weekly ? weekly.window_end : node.window_end;
  const offsetDays = existing ? existing.window_end_offset_days
    : weekly ? (weekly.window_end_offset_days || 0) : node.window_end_offset_days;
  const closeDate = offsetDays === 1 ? datePlusDays(date, 1) : date;
  const closeISO = localDateTimeToISO(closeDate, windowEnd, env.LOCAL_TZ || "UTC");
  return new Date(closeISO).getTime() <= Date.now() + 24 * 60 * 60 * 1000;
}

// Loosening: wider window, larger geofence, disabling requires_todo
function isLoosening(field, current, next, node) {
  if (field === "window_start") return next > current;  // later start = loosening
  if (field === "window_end") return next < current;    // earlier end = loosening (normal windows)
  if (field === "geofence_radius_m") return next > current;
  if (field === "requires_todo") return current === 1 && next === 0;
  if (field === "todo_grace_minutes") return Number(next) > Number(current);  // more slack = loosening
  if (field === "window_end_offset_days") return next < current;
  // Dropping any applied day = loosening; adding days only = tightening
  if (field === "days_of_week") return String(current).split("").some(d => !String(next).includes(d));
  // Per-day windows: if any weekday's effective window loosens vs the current
  // state (weekly entry, else node defaults), the whole change waits 24h
  if (field === "weekly_windows") {
    const parse = (v) => { if (!v) return {}; try { return JSON.parse(v); } catch (e) { return {}; } };
    const cur = parse(current), nxt = parse(next);
    for (let d = 0; d < 7; d++) {
      const c = { window_start: node.window_start, window_end: node.window_end,
                  window_end_offset_days: node.window_end_offset_days, ...(cur[d] || {}) };
      const n = { window_start: node.window_start, window_end: node.window_end,
                  window_end_offset_days: node.window_end_offset_days, ...(nxt[d] || {}) };
      if (isLoosening("window_start", c.window_start, n.window_start)
        || isLoosening("window_end", c.window_end, n.window_end)
        || isLoosening("window_end_offset_days", c.window_end_offset_days || 0, n.window_end_offset_days || 0)) return true;
    }
    return false;
  }
  return false;
}

// Charging goes through Beeminder, not a merchant account of our own
// (2026-08). A self-owned Stripe account charging its owner's card was the
// wrong shape: it needed business verification, and the money came straight
// back minus fees, so failure never actually cost anything. Beeminder is a
// commitment device — it holds the card, the money genuinely leaves, and
// there is nothing to underwrite.
//
// No idempotency key exists on their API, so double-charging is prevented
// the same way it always was: the caller checks charge_log for this
// node+date before it ever gets here, and writes a row immediately after.
// KILL SWITCH (2026-08-04). Charging is disabled outright, deliberately,
// after money was being taken unexpectedly. This returns BEFORE the
// fetch, so no request reaches Beeminder from any caller — the cron judge or
// the admin test-charge route. LIVE_CHARGING and CHARGE_DRYRUN in
// wrangler.toml are set to the safe values as well; this stub is the layer
// that does not depend on a var being right. 'disabled' is not counted by
// weeklySpentCents, and it is not 'unknown', so nothing here is retryable.
// Re-enabling is deliberate: delete this block AND flip the vars back.
async function beeminderCharge(env, amountCents, note) {
  return { status: "disabled", id: null, error: "charging disabled" };
  /* eslint-disable no-unreachable */
  if (!env.BEEMINDER_AUTH_TOKEN || !env.BEEMINDER_USER) {
    return { status: "failed", id: null, error: "beeminder not configured" };
  }
  // Their minimum is $1.00; our cheapest failure is $2.00, but clamp anyway
  // so a mis-set var can never send an amount the API rejects outright.
  const dollars = Math.max(1, Number(amountCents) / 100).toFixed(2);
  const body = new URLSearchParams({
    auth_token: env.BEEMINDER_AUTH_TOKEN,
    user_id: env.BEEMINDER_USER,
    amount: dollars,
    note,
  });
  if (env.CHARGE_DRYRUN === "true") body.set("dryrun", "1");
  let resp;
  try {
    resp = await fetch("https://www.beeminder.com/api/v1/charges.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    // The request may well have REACHED Beeminder and created the charge —
    // only the response was lost. So this is 'unknown', never 'failed': a
    // failed charge is one the system is entitled to retry, and retrying a
    // charge that actually went through is how you get billed a hundred
    // times. 'unknown' counts against the weekly cap for the same reason.
    return { status: "unknown", id: null, error: String(e) };
  }
  const data = await resp.json().catch(() => ({}));
  return {
    status: resp.ok ? (env.CHARGE_DRYRUN === "true" ? "dryrun" : "succeeded") : "failed",
    id: data.id ?? null,
    error: resp.ok ? null : (data.errors?.message || data.error_message || `HTTP ${resp.status}`),
  };
  /* eslint-enable no-unreachable */
}

// Lazy tables for the routine gate — same idiom as ensureChargeColumns, so a
// worker deployed before the app pushed anything still judges cleanly.
async function ensureRoutineTables(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS routine_required (node_id INTEGER PRIMARY KEY)"
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS routine_events (
       node_id INTEGER NOT NULL,
       date    TEXT NOT NULL,
       done_at TEXT NOT NULL,
       PRIMARY KEY (node_id, date)
     )`
  ).run();
}

async function sendSummaryEmail(env, date, lines) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "RESEND_API_KEY not set" };
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.SUMMARY_EMAIL_FROM,
      to: env.SUMMARY_EMAIL_TO,
      subject: `Accountability summary ${date}`,
      text: lines.join("\n"),
    }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    console.error(`summary email failed: ${resp.status} ${body}`);
  }
  return { sent: resp.ok, status: resp.status, detail: body.slice(0, 300) };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function localDateStr(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

function localTimeStr(date, tz) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

// '0'=Mon..'6'=Sun, matching the days_of_week digit convention
function dowOf(dateStr) {
  return String((new Date(dateStr + "T12:00:00Z").getUTCDay() + 6) % 7);
}

// Per-weekday default window for a date, or null to fall back to node defaults.
// Guarded parse: a malformed blob must not break the scheduled charging pass.
function weeklyWindowFor(node, dateStr) {
  if (!node.weekly_windows) return null;
  try {
    return JSON.parse(node.weekly_windows)[dowOf(dateStr)] || null;
  } catch (e) {
    return null;
  }
}

function datePlusDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Convert a local date + HH:MM into an ISO UTC string using the Worker's timezone
function localDateTimeToISO(dateStr, hhmm, tz) {
  // Construct a date in local time and convert to UTC via Intl trick
  const [h, m] = hhmm.split(":").map(Number);
  // Use a reference parse: build the date in UTC noon, then adjust
  // Simpler: use the timezone offset at that moment via formatting
  const candidate = new Date(`${dateStr}T${hhmm}:00`);
  // Get the UTC offset for this tz at this moment
  const utcStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(candidate);
  const localStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(candidate);
  // Difference between what UTC thinks and what local thinks
  const utcDate = new Date(utcStr.replace(", ", "T").replace(/\//g, "-") + "Z");
  const localDate = new Date(localStr.replace(", ", "T").replace(/\//g, "-") + "Z");
  const offsetMs = localDate - utcDate;
  return new Date(new Date(`${dateStr}T${hhmm}:00Z`).getTime() - offsetMs).toISOString();
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

function renderScanPage(node, isJournal) {
  return `<!doctype html>
<html><body>
<h3>${node.label}</h3>
<p id="status">Checking location...</p>
<button id="submitBtn" disabled>Submit</button>
<script>
const isJournal = ${isJournal ? "true" : "false"};
let coords = {};
const watchId = navigator.geolocation.watchPosition(
  (pos) => {
    coords = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) };
    document.getElementById("status").textContent = "Location captured (±" + coords.accuracy + "m) — waiting refines it.";
    document.getElementById("submitBtn").disabled = false;
  },
  () => {
    document.getElementById("status").textContent = "Location unavailable — submitting without it.";
    document.getElementById("submitBtn").disabled = false;
  },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
);
document.getElementById("submitBtn").onclick = async () => {
  navigator.geolocation.clearWatch(watchId);
  const resp = await fetch(window.location.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...coords }),
  });
  const msg = await resp.text();
  if (isJournal) {
    document.body.innerHTML = "<h3>" + msg + "</h3><p>Opening tonight's journal...</p>";
    setTimeout(() => { window.location.href = "/journal?from=scan"; }, 700);
  } else {
    document.body.innerHTML = "<h3>" + msg + "</h3>";
  }
};
</script>
</body></html>`;
}

// Lazy creation: the deploy token lacks D1 query access, so guarantee the table here
// Lazy migration: the deploy token lacks D1 query access, so add the column here
async function ensureChargeColumns(env) {
  try {
    await env.DB.prepare(
      "ALTER TABLE charge_log ADD COLUMN amount_cents INTEGER"
    ).run();
  } catch (e) {}
}

// Rolling weekly spend guard. A runaway week (a broken geofence, a trip, a
// dead phone) should cost at most WEEKLY_CHARGE_CAP_CENTS — the cap is a
// safety rail, not a budget, so a charge that would breach it is SKIPPED
// whole rather than partially billed, and logged as 'capped' so the reason is
// visible in the log rather than looking like a silent miss.
// Window is the last 7 local days inclusive, which needs no week-boundary
// bookkeeping and can't be gamed by a Monday failure.
// Counts every status where money MIGHT have left, not just confirmed
// 'succeeded'. Counting only confirmations made the cap blind to exactly the
// runaway it exists to bound: the failure mode is that confirmation never
// arrives, so the rows that most need counting were the ones being skipped,
// and the cap read $0 spent while the card was being hit repeatedly.
async function weeklySpentCents(env, throughDate) {
  const since = datePlusDays(throughDate, -6);
  const { results } = await env.DB.prepare(
    `SELECT failure_reason, amount_cents FROM charge_log
     WHERE date >= ? AND date <= ?
       AND charge_status IN ('succeeded', 'charging', 'unknown')`
  ).bind(since, throughDate).all();
  return results.reduce((sum, r) => sum + (
    r.amount_cents != null ? Number(r.amount_cents)
      // Rows written before amount_cents existed: reconstruct from the reason,
      // which is exactly why the reason is stored.
      : Number(r.failure_reason === "under_social_floor"
          ? (env.SOCIAL_CHARGE_AMOUNT_CENTS || "800")
          : (env.CHARGE_AMOUNT_CENTS || "1000"))
  ), 0);
}

async function ensureScanColumns(env) {
  try {
    await env.DB.prepare("ALTER TABLE scan_events ADD COLUMN accuracy_m REAL").run();
  } catch (e) {}
}

// Lazy migration: the deploy token lacks D1 query access, so add the columns here
async function ensureDaysColumn(env) {
  try {
    await env.DB.prepare(
      "ALTER TABLE nodes ADD COLUMN days_of_week TEXT NOT NULL DEFAULT '0123456'"
    ).run();
  } catch (e) {}
  try {
    await env.DB.prepare("ALTER TABLE nodes ADD COLUMN weekly_windows TEXT").run();
  } catch (e) {}
  try {
    await env.DB.prepare(
      "ALTER TABLE nodes ADD COLUMN todo_grace_minutes INTEGER NOT NULL DEFAULT 0"
    ).run();
  } catch (e) {}
}

// ── People CRM phone surface (spec-people-crm.md) ────────────────────────────
// Needs (beyond INTERNAL_SECRET): PEOPLE_PASS_HASH, PEOPLE_SALT,
// PEOPLE_COOKIE_SECRET — all Workers secrets. See the header comment at the top
// of this file for how to compute PEOPLE_PASS_HASH.

const PEOPLE_SESS_MS = 30 * 24 * 60 * 60 * 1000;  // 30-day signed session
const PEOPLE_MAX_FAILS = 10;                       // global lockout threshold
const PEOPLE_LOCK_MS = 60 * 60 * 1000;             // 1-hour lock once tripped

// All three secrets must be present, or the /people surface refuses to run —
// an empty HMAC key / empty hash would be trivially forgeable.
function peopleConfigured(env) {
  return !!((env.PEOPLE_PASS_HASH || "").trim()
    && (env.PEOPLE_SALT || "").trim()
    && (env.PEOPLE_COOKIE_SECRET || "").trim());
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return bufToHex(digest);
}

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufToHex(sig);
}

// Fixed-time compare: folds the length difference into the accumulator and
// always walks the longer input, so it never early-returns on a length mismatch.
// (Both sides here are fixed-length hex digests, so iteration count is constant.)
function timingSafeEqualHex(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ea[i] || 0) ^ (eb[i] || 0);
  }
  return diff === 0;
}

// Session cookie value = <expiry-ms>.<hex HMAC-SHA256(expiry, COOKIE_SECRET)>.
async function makePeopleCookie(env) {
  const expiry = String(Date.now() + PEOPLE_SESS_MS);
  const sig = await hmacHex(expiry, (env.PEOPLE_COOKIE_SECRET || "").trim());
  const value = `${expiry}.${sig}`;
  const maxAge = Math.floor(PEOPLE_SESS_MS / 1000);
  return `people_sess=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// Verify signature (constant-time) THEN expiry — tampering the expiry breaks the
// signature, so an attacker cannot mint a longer-lived cookie.
async function verifyPeopleCookie(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const m = cookieHeader.match(/(?:^|;\s*)people_sess=([^;]+)/);
  if (!m) return false;
  const raw = m[1];
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return false;
  const expiry = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmacHex(expiry, (env.PEOPLE_COOKIE_SECRET || "").trim());
  if (!timingSafeEqualHex(sig, expected)) return false;
  const exp = Number(expiry);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return true;
}

// Append one op to the capture blob (JSON array). Guarded parse: a corrupt blob
// resets to a fresh array rather than throwing.
async function appendCapture(env, op) {
  const row = await env.DB.prepare("SELECT * FROM people_capture WHERE id = 1").first();
  let arr = [];
  if (row && row.content) {
    try { const p = JSON.parse(row.content); if (Array.isArray(p)) arr = p; } catch (e) {}
  }
  arr.push(op);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO people_capture (id, content, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(arr), now).run();
}

async function recordCrmOutcome(env, date, satisfied) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO crm_outcomes (date, satisfied, recorded_at) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET satisfied = excluded.satisfied, recorded_at = excluded.recorded_at`
  ).bind(date, satisfied ? 1 : 0, now).run();
}

async function ensurePeopleTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS people_snapshot (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       content TEXT NOT NULL DEFAULT '',
       updated_at TEXT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS people_capture (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       content TEXT NOT NULL DEFAULT '',
       updated_at TEXT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS crm_outcomes (
       date TEXT UNIQUE NOT NULL,
       satisfied INTEGER NOT NULL,
       recorded_at TEXT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS people_auth (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       fails INTEGER NOT NULL DEFAULT 0,
       locked_until TEXT
     )`
  ).run();
}

// ── Journal (nightly sleep-QR fill) ──────────────────────────────────────────
// journal_entry mirrors the app's journal_day. journal_config (single row) holds
// which node opens the form and this week's habit label, both pushed by the app.

async function ensureJournalTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS journal_entry (
       date TEXT PRIMARY KEY,
       bottleneck TEXT NOT NULL DEFAULT '',
       active_experiment TEXT NOT NULL DEFAULT '',
       rating INTEGER,
       habit_mark TEXT,
       updated_at TEXT NOT NULL
     )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS journal_config (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       node_id INTEGER,
       habit TEXT NOT NULL DEFAULT '',
       habit_week_start TEXT,
       updated_at TEXT NOT NULL
     )`
  ).run();
}

// Full-row replace with last-write-wins by updated_at (desktop → cloud push).
async function upsertJournalEntry(env, e) {
  const ts = e.updated_at || new Date().toISOString();
  const existing = await env.DB.prepare(
    "SELECT updated_at FROM journal_entry WHERE date = ?"
  ).bind(e.date).first();
  if (existing && existing.updated_at && existing.updated_at >= ts) return;
  await env.DB.prepare(
    `INSERT INTO journal_entry (date, bottleneck, active_experiment, rating, habit_mark, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       bottleneck = excluded.bottleneck, active_experiment = excluded.active_experiment,
       rating = excluded.rating, habit_mark = excluded.habit_mark, updated_at = excluded.updated_at`
  ).bind(e.date, e.bottleneck || "", e.active_experiment || "",
         e.rating ?? null, e.habit_mark ?? null, ts).run();
}

// Phone save: today's row takes the rating + habit mark (leaving last night's
// bottleneck/experiment intact); tomorrow's row takes the bottleneck + experiment.
async function saveJournalFromPhone(env, { today, tomorrow, rating, habit_mark, bottleneck, active_experiment }) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO journal_entry (date, rating, habit_mark, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       rating = excluded.rating, habit_mark = excluded.habit_mark, updated_at = excluded.updated_at`
  ).bind(today, rating ?? null, habit_mark ?? null, now).run();
  await env.DB.prepare(
    `INSERT INTO journal_entry (date, bottleneck, active_experiment, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       bottleneck = excluded.bottleneck, active_experiment = excluded.active_experiment, updated_at = excluded.updated_at`
  ).bind(tomorrow, bottleneck || "", active_experiment || "", now).run();
}

const JOURNAL_STYLE = `
  body { font-family:-apple-system,system-ui,sans-serif; max-width:480px; margin:0 auto;
         padding:20px 16px 48px; background:#14161a; color:#e8eaed; }
  h3 { margin:0 0 4px; } .date { color:#8a90a0; font-size:14px; margin-bottom:20px; }
  .sec { border:1px solid #2a2e35; border-radius:10px; padding:14px; margin-bottom:16px; }
  .sec h4 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:#9aa0b0; }
  .label { font-size:14px; margin:14px 0 8px; }
  .ctx { font-size:13px; color:#c3c9d4; margin-bottom:12px; background:#1c1f24; padding:8px 10px; border-radius:6px; }
  .muted { color:#8a90a0; }
  .rrow { display:flex; gap:6px; } .rbtn { flex:1; padding:12px 0; }
  .row3 { display:flex; gap:8px; } .hbtn { flex:1; padding:12px 0; }
  button { font:inherit; font-size:16px; color:#e8eaed; background:#1c1f24;
           border:1px solid #2a2e35; border-radius:8px; cursor:pointer; }
  .rbtn.sel, .hbtn.sel { background:#2a4a8a; border-color:#3a5aaa; }
  textarea { width:100%; box-sizing:border-box; font:inherit; font-size:16px; padding:10px;
             color:#e8eaed; background:#1c1f24; border:1px solid #2a2e35; border-radius:8px; min-height:64px; }
  .save { width:100%; font-size:17px; padding:14px; background:#2a4a8a; border:none; margin-top:4px; }
  .ok { color:#7fce8f; font-size:14px; margin-bottom:14px; }
  .err { color:#e0776a; font-size:14px; }
  input { font:inherit; font-size:16px; padding:12px; color:#e8eaed;
          background:#1c1f24; border:1px solid #2a2e35; border-radius:8px; }
  form { display:flex; flex-direction:column; gap:12px; }
  .nextlink { display:block; box-sizing:border-box; width:100%; margin-top:14px;
              padding:14px; text-align:center; text-decoration:none; font-size:16px;
              color:#e8eaed; background:#1c1f24; border:1px solid #2a2e35;
              border-radius:8px; }
`;

function jEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderJournalLogin(error) {
  const err = error ? `<p class="err">${jEsc(error)}</p>` : "";
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journal</title>
<style>${JOURNAL_STYLE}</style>
</head><body>
<h3>Journal</h3>
${err}
<form method="POST" action="/journal">
  <input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
  <button type="submit">Unlock</button>
</form>
</body></html>`;
}

function renderJournalPage({ today, tomorrow, habit, todayRow, tomRow, fromScan }) {
  const rating = todayRow.rating;
  const mark = todayRow.habit_mark;
  const todayExp = todayRow.active_experiment || "";
  const ratingBtns = [1, 2, 3, 4, 5, 6, 7]
    .map((n) => `<button type="button" class="rbtn${rating === n ? " sel" : ""}" data-rate="${n}">${n}</button>`)
    .join("");
  const habitSection = habit
    ? `<div class="label">Habit — “${jEsc(habit)}”</div>
       <div class="row3">
         ${["ehh", "good", "great"].map((v) =>
           `<button type="button" class="hbtn${mark === v ? " sel" : ""}" data-mark="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}
       </div>`
    : `<div class="label">Habit</div><div class="muted">No habit set this week — add one in your weekly review.</div>`;
  const expContext = todayExp
    ? `<div class="ctx">Today’s experiment: ${jEsc(todayExp)}</div>`
    : `<div class="ctx muted">No experiment was set for today.</div>`;
  const banner = fromScan ? `<div class="ok">✓ Sleep scan logged</div>` : "";
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journal</title>
<style>${JOURNAL_STYLE}</style>
</head><body>
${banner}
<h3>Tonight’s journal</h3>
<div class="date">${jEsc(today)}</div>

<div class="sec">
  <h4>Rate today</h4>
  ${expContext}
  <div class="label">Rating (1–7)</div>
  <div class="rrow">${ratingBtns}</div>
  ${habitSection}
</div>

<div class="sec">
  <h4>Set tomorrow · ${jEsc(tomorrow)}</h4>
  <div class="label">Biggest bottleneck</div>
  <textarea id="bottleneck" placeholder="What will most get in your way tomorrow?">${jEsc(tomRow.bottleneck || "")}</textarea>
  <div class="label">Active experiment</div>
  <textarea id="experiment" placeholder="What are you testing tomorrow?">${jEsc(tomRow.active_experiment || "")}</textarea>
</div>

<button class="save" id="save">Save</button>
<p id="status"></p>

<a class="nextlink" href="/people">Log people &amp; add contacts →</a>

<script>
let rating = ${rating == null ? "null" : rating};
let mark = ${mark == null ? "null" : `"${mark}"`};
document.querySelectorAll(".rbtn").forEach((b) => b.onclick = () => {
  rating = Number(b.dataset.rate);
  document.querySelectorAll(".rbtn").forEach((x) => x.classList.remove("sel"));
  b.classList.add("sel");
});
document.querySelectorAll(".hbtn").forEach((b) => b.onclick = () => {
  mark = b.dataset.mark;
  document.querySelectorAll(".hbtn").forEach((x) => x.classList.remove("sel"));
  b.classList.add("sel");
});
document.getElementById("save").onclick = async () => {
  const st = document.getElementById("status");
  st.textContent = "Saving…"; st.className = "";
  const resp = await fetch("/journal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      op: "save", rating: rating, habit_mark: mark,
      bottleneck: document.getElementById("bottleneck").value,
      active_experiment: document.getElementById("experiment").value,
    }),
  });
  if (resp.ok) { st.textContent = "Saved ✓"; st.className = "ok"; }
  else { st.textContent = "Save failed (" + resp.status + ")"; st.className = "err"; }
};
</script>
</body></html>`;
}

function renderPeopleLogin(error) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const err = error ? `<p class="err">${esc(error)}</p>` : "";
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>People</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 420px;
         margin: 0 auto; padding: 48px 16px; background: #14161a; color: #e8eaed; }
  h3 { margin: 0 0 16px; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input { font: inherit; font-size: 16px; padding: 12px; color: #e8eaed;
          background: #1c1f24; border: 1px solid #2a2e35; border-radius: 8px; }
  button { font: inherit; font-size: 16px; padding: 12px; color: #e8eaed;
           background: #2a4a8a; border: none; border-radius: 8px; }
  .err { color: #e0776a; font-size: 14px; }
</style>
</head><body>
<h3>People</h3>
${err}
<form method="POST" action="/people">
  <input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
  <button type="submit">Unlock</button>
</form>
</body></html>`;
}

// Authed page. Reads the app-pushed snapshot ({people:[...], interactions:[...]})
// and embeds it for client-side search + per-person read history. All list DOM
// is built with textContent (never innerHTML from data), and the embedded JSON
// escapes '<' so it cannot break out of the <script> — the snapshot is
// user-authored, so it is treated as untrusted here.
function renderPeoplePage(snapRow, today) {
  let snap = {};
  if (snapRow && snapRow.content) {
    try { snap = JSON.parse(snapRow.content) || {}; } catch (e) { snap = {}; }
  }
  const people = Array.isArray(snap.people) ? snap.people : [];
  const interactions = Array.isArray(snap.interactions) ? snap.interactions : [];
  const dataJson = JSON.stringify({ people, interactions, today }).replace(/</g, "\\u003c");
  const updated = snapRow && snapRow.updated_at ? snapRow.updated_at : null;
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>People</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 560px;
         margin: 0 auto; padding: 20px 16px 64px; background: #14161a; color: #e8eaed; }
  h3 { margin: 0 0 4px; }
  h4 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase;
       letter-spacing: .04em; color: #9aa0a6; }
  .meta { color: #9aa0a6; font-size: 13px; margin-bottom: 16px; }
  .muted { color: #9aa0a6; font-size: 13px; }
  .section { margin-top: 28px; }
  .row { margin-bottom: 8px; }
  input, select, textarea { width: 100%; box-sizing: border-box; font: inherit;
         font-size: 16px; padding: 10px; color: #e8eaed; background: #1c1f24;
         border: 1px solid #2a2e35; border-radius: 8px; }
  button { margin-top: 8px; font: inherit; font-size: 16px; padding: 10px 20px;
           color: #e8eaed; background: #2a4a8a; border: none; border-radius: 8px; }
  button.ghost { background: #1c1f24; border: 1px solid #2a2e35; margin-left: 8px; }
  .status { font-size: 13px; color: #9aa0a6; margin-top: 6px; min-height: 1em; }
  .due-row { padding: 8px 0; border-bottom: 1px solid #23262c; }
  .due-name { font-weight: 600; }
  .due-action { color: #9aa0a6; font-size: 14px; }
  .pcard { padding: 10px 0; border-bottom: 1px solid #23262c; }
  .pname { font-weight: 600; cursor: pointer; }
  .psub { color: #9aa0a6; font-size: 13px; }
  .phist { margin-top: 8px; padding-left: 10px; border-left: 2px solid #2a2e35; }
  .hitem { font-size: 14px; padding: 3px 0; }
  .hdate { color: #7b8794; font-variant-numeric: tabular-nums; }
</style>
</head><body>
<h3>People</h3>
<div class="meta" id="meta"></div>

<div class="section">
  <h4>Due</h4>
  <div id="due"></div>
</div>

<div class="section">
  <h4>Add entry</h4>
  <div class="row"><select id="e-person"></select></div>
  <div class="row"><input type="date" id="e-date"></div>
  <div class="row"><input type="text" id="e-note" placeholder="What happened (one line)"></div>
  <button id="e-save">Log entry</button>
  <button id="nothing" class="ghost">No new entries today</button>
  <div class="status" id="e-status"></div>
</div>

<div class="section">
  <h4>New person</h4>
  <div class="row"><input type="text" id="np-name" placeholder="Name (required)"></div>
  <div class="row"><input type="text" id="np-company" placeholder="Company"></div>
  <div class="row"><input type="text" id="np-location" placeholder="Location"></div>
  <div class="row"><input type="text" id="np-next" placeholder="Next action"></div>
  <button id="np-save">Add person</button>
  <div class="status" id="np-status"></div>
</div>

<div class="section">
  <h4>People</h4>
  <div class="row"><input type="search" id="search" placeholder="Search name..."></div>
  <div id="list"></div>
</div>
<script>
const DATA = ${dataJson};
const updated = ${JSON.stringify(updated)};
const $ = (id) => document.getElementById(id);
if (updated) $("meta").textContent = "Snapshot updated " + new Date(updated).toLocaleString();
$("e-date").value = DATA.today;

const people = DATA.people.filter((p) => !p.archived);
const sel = $("e-person");
people.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((p) => {
  const o = document.createElement("option");
  o.value = p.id; o.textContent = p.name;
  sel.appendChild(o);
});

const due = people.filter((p) => p.next_due && String(p.next_due) <= DATA.today);
const dueEl = $("due");
if (!due.length) {
  const d = document.createElement("div"); d.className = "muted"; d.textContent = "Nothing due.";
  dueEl.appendChild(d);
} else {
  due.forEach((p) => {
    const row = document.createElement("div"); row.className = "due-row";
    const nm = document.createElement("div"); nm.className = "due-name"; nm.textContent = p.name;
    const na = document.createElement("div"); na.className = "due-action"; na.textContent = p.next_action || "";
    row.appendChild(nm); if (p.next_action) row.appendChild(na); dueEl.appendChild(row);
  });
}

function historyFor(pid) {
  return DATA.interactions
    .filter((i) => String(i.person_id) === String(pid))
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

const listEl = $("list");
function renderList(q) {
  listEl.textContent = "";
  const ql = (q || "").toLowerCase();
  people
    .filter((p) => !ql || String(p.name).toLowerCase().includes(ql))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .forEach((p) => {
      const card = document.createElement("div"); card.className = "pcard";
      const head = document.createElement("div"); head.className = "pname"; head.textContent = p.name;
      const sub = document.createElement("div"); sub.className = "psub";
      sub.textContent = [p.company, p.location].filter(Boolean).join(" · ");
      const hist = document.createElement("div"); hist.className = "phist"; hist.style.display = "none";
      head.onclick = () => {
        if (hist.dataset.built !== "1") {
          if (p.next_action) {
            const na = document.createElement("div"); na.className = "muted";
            na.textContent = "Next: " + p.next_action; hist.appendChild(na);
          }
          const items = historyFor(p.id);
          if (!items.length) {
            const mm = document.createElement("div"); mm.className = "muted";
            mm.textContent = "No past notes."; hist.appendChild(mm);
          } else {
            items.forEach((i) => {
              const line = document.createElement("div"); line.className = "hitem";
              const dt = document.createElement("span"); dt.className = "hdate"; dt.textContent = i.date + "  ";
              const tx = document.createElement("span"); tx.textContent = i.note || "";
              line.appendChild(dt); line.appendChild(tx); hist.appendChild(line);
            });
          }
          hist.dataset.built = "1";
        }
        hist.style.display = hist.style.display === "none" ? "block" : "none";
      };
      card.appendChild(head);
      if (sub.textContent) card.appendChild(sub);
      card.appendChild(hist);
      listEl.appendChild(card);
    });
}
renderList("");
$("search").addEventListener("input", (e) => renderList(e.target.value));

async function post(op, statusId) {
  const st = $(statusId);
  st.textContent = "Saving...";
  const resp = await fetch("/people", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(op),
  }).catch(() => null);
  if (resp && resp.ok) { st.textContent = "Saved."; return true; }
  st.textContent = "Save failed — retry.";
  return false;
}

$("e-save").onclick = async () => {
  const pid = sel.value;
  const note = $("e-note").value.trim();
  const date = $("e-date").value || DATA.today;
  if (!pid || !note) { $("e-status").textContent = "Pick a person and enter a note."; return; }
  const person_id = isNaN(Number(pid)) ? pid : Number(pid);
  if (await post({ op: "entry", person_id, date, note }, "e-status")) $("e-note").value = "";
};
$("nothing").onclick = () => post({ op: "nothing" }, "e-status");
$("np-save").onclick = async () => {
  const name = $("np-name").value.trim();
  if (!name) { $("np-status").textContent = "Name is required."; return; }
  const ok = await post({
    op: "new_person", name,
    company: $("np-company").value.trim(),
    location: $("np-location").value.trim(),
    next_action: $("np-next").value.trim(),
  }, "np-status");
  if (ok) { $("np-name").value = ""; $("np-company").value = ""; $("np-location").value = ""; $("np-next").value = ""; }
};
</script>
</body></html>`;
}

async function ensureTodoTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS todo_page (
       date TEXT PRIMARY KEY,
       content TEXT NOT NULL DEFAULT '',
       updated_at TEXT NOT NULL
     )`
  ).run();
}

// Single-row inbox blob, one item per line
async function ensureInboxTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS inbox_page (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       content TEXT NOT NULL DEFAULT '',
       updated_at TEXT NOT NULL
     )`
  ).run();
}

function renderTodoPage(row, inboxRow, submitInfo) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<textarea id="content">${esc(row.content)}</textarea>
<button id="saveBtn">Save</button>`;
  const showSubmit = submitInfo && submitInfo.required > 0;
  const submitBlock = showSubmit ? `<div class="submit-block">
<div class="submit-status" id="submit-status"></div>
<button id="submitBtn">Submit to-do for today</button>
</div>` : "";
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>To-Do</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 0 auto; padding: 24px 16px; background: #14161a; color: #e8eaed; }
  h3 { margin: 0 0 4px; }
  .meta { color: #9aa0a6; font-size: 13px; margin-bottom: 16px; }
  .content { font-size: 16px; line-height: 1.6; }
  textarea { width: 100%; box-sizing: border-box; min-height: 60vh; resize: vertical;
             font: inherit; font-size: 16px; line-height: 1.6; color: #e8eaed;
             background: #1c1f24; border: 1px solid #2a2e35; border-radius: 8px;
             padding: 12px; }
  #inbox-content { min-height: 20vh; }
  button { margin-top: 12px; font: inherit; font-size: 16px; padding: 10px 24px;
           color: #e8eaed; background: #2a4a8a; border: none; border-radius: 8px; }
  button:disabled { opacity: 0.5; }
  .section { margin-top: 32px; }
  .submit-block { margin-top: 16px; }
  #submitBtn { background: #2f7d46; }
  .submit-status { font-size: 14px; margin-bottom: 4px; }
  .submit-status.done { color: #7bd88f; }
  .submit-status.pending { color: #e0b341; }
</style>
</head><body>
<h3>To-Do — ${esc(row.date)}</h3>
<div class="meta" id="meta"></div>
${body}
${submitBlock}
<div class="section">
<h3>Inbox</h3>
<div class="meta" id="inbox-meta"></div>
<textarea id="inbox-content" placeholder="One item per line">${esc(inboxRow.content)}</textarea>
<button id="inboxSaveBtn">Save</button>
</div>
<script>
const rowDate = ${JSON.stringify(row.date)};
const updatedAt = ${JSON.stringify(row.updated_at)};
const inboxUpdatedAt = ${JSON.stringify(inboxRow.updated_at)};
const submitInfo = ${JSON.stringify(submitInfo || null)};
if (updatedAt) {
  document.getElementById("meta").textContent =
    "Updated " + new Date(updatedAt).toLocaleString();
}
if (inboxUpdatedAt) {
  document.getElementById("inbox-meta").textContent =
    "Updated " + new Date(inboxUpdatedAt).toLocaleString();
}
const baselines = {
  content: document.getElementById("content").value,
  "inbox-content": document.getElementById("inbox-content").value,
};
function renderSubmitStatus() {
  if (!submitInfo || !submitInfo.required) return;
  const el = document.getElementById("submit-status");
  const btn = document.getElementById("submitBtn");
  const done = submitInfo.submitted >= submitInfo.required && submitInfo.submitted > 0;
  if (done) {
    el.className = "submit-status done";
    el.textContent = "✓ Submitted " + new Date(submitInfo.submitted_at).toLocaleString();
    btn.textContent = "Re-submit";
  } else {
    el.className = "submit-status pending";
    el.textContent = "Not submitted yet";
    btn.textContent = "Submit to-do for today";
  }
}
if (submitInfo && submitInfo.required) {
  renderSubmitStatus();
  document.getElementById("submitBtn").onclick = async () => {
    const btn = document.getElementById("submitBtn");
    btn.disabled = true;
    btn.textContent = "Submitting...";
    const resp = await fetch(window.location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submit: true, content: document.getElementById("content").value }),
    }).catch(() => null);
    btn.disabled = false;
    if (resp && resp.ok) {
      const data = await resp.json();
      submitInfo.submitted = submitInfo.required;
      submitInfo.submitted_at = data.submitted_at;
      baselines.content = document.getElementById("content").value;
      document.getElementById("meta").textContent =
        "Updated " + new Date(data.submitted_at).toLocaleString();
      renderSubmitStatus();
    } else {
      btn.textContent = "Submit failed — retry";
    }
  };
}
function wireSave(btnId, metaId, taId, makeBody) {
  document.getElementById(btnId).onclick = async () => {
    const btn = document.getElementById(btnId);
    btn.disabled = true;
    btn.textContent = "Saving...";
    const resp = await fetch(window.location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    }).catch(() => null);
    btn.disabled = false;
    if (resp && resp.ok) {
      const data = await resp.json();
      baselines[taId] = document.getElementById(taId).value;
      btn.textContent = "Save";
      document.getElementById(metaId).textContent =
        "Updated " + new Date(data.updated_at).toLocaleString();
    } else {
      btn.textContent = "Save failed — retry";
    }
  };
}
wireSave("saveBtn", "meta", "content", () => ({ date: rowDate, content: document.getElementById("content").value }));
wireSave("inboxSaveBtn", "inbox-meta", "inbox-content", () => ({ inbox: true, content: document.getElementById("inbox-content").value }));

// Auto-refresh to pick up content pushed from the app, but never while the
// user has unsaved edits or is actively typing (that was wiping input).
setInterval(() => {
  const dirty = Object.keys(baselines).some(
    (id) => document.getElementById(id).value !== baselines[id]
  );
  const editing = document.activeElement &&
    document.activeElement.tagName === "TEXTAREA";
  if (!dirty && !editing) location.reload();
}, 60000);
</script>
</body></html>`;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
