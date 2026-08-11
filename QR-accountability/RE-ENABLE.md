# Re-enabling Beeminder charging — the protocol

Charging was hard-disabled 2026-08-04 after money left unexpectedly
(double-charges: Beeminder's charges API has no idempotency key, and at the
time the weekly cap did not count unconfirmed rows). Both are fixed in code —
reserve-before-charge and `unknown`-is-terminal-and-counted — but re-enabling
is still a deliberate, staged act. Do the steps IN ORDER; each one is safe to
stop at.

## Step 0 — cap the money at the card (do this FIRST, nothing else matters as much)

Give Beeminder a VIRTUAL card with a hard monthly limit (~$30/mo). After
this, the worst case of any bug anywhere is a DECLINE, not a loss. No code
layer can promise that.

How (privacy.com, free tier, ~10 min): sign up + link checking via Plaid →
New Card → MERCHANT-LOCKED, name it Beeminder → spend limit $30/MONTH →
add the number in beeminder.com account settings → REMOVE the real card so
charges have no fallback. The app's per-card PAUSE toggle is a second kill
switch. Verify Beeminder/Stripe actually accepts the card — Step 2's $2
live week is the natural test; if it declines as prepaid, fall back to a
bank virtual number with amount limits (Citi has them; Eno does not).

## Step 1 — token back, still dry

```
wrangler secret put BEEMINDER_AUTH_TOKEN     # in QR-accountability/
```

The stub `return { status: "disabled", … }` and its eslint-disable pair were
removed from `beeminderCharge()` on 2026-08-11, so this step is now: set
`BEEMINDER_USER` in wrangler.toml (it ships EMPTY, and an empty username makes
every charge return `failed: beeminder not configured` — a lock in its own
right) and `wrangler deploy`, with `LIVE_CHARGING = "false"` and
`CHARGE_DRYRUN = "true"` still set. Verify:

```
POST /admin/billing/test-charge          # dry by default; expect status dryrun
GET  /admin/billing                      # weekly_spent 0, recent charge listed as dryrun
```

Live for ONE WEEK of real judgments in dryrun. The per-judgment emails show
every charge that WOULD have fired. If the week's would-be charges look
right, continue.

## Step 2 — live at trivial stakes

wrangler.toml: `CHARGE_DRYRUN = "false"`, `LIVE_CHARGING = "true"`,
`CHARGE_AMOUNT_CENTS = "200"` (and SOCIAL_… likewise). Deploy. One week of
real $2 charges, virtual card as the ceiling. Check the email lands within
minutes of any charge.

## Step 3 — real amounts

Restore CHARGE_AMOUNT_CENTS / SOCIAL_CHARGE_AMOUNT_CENTS. Deploy. Add a
weekly-review glance at GET /admin/billing (recent_charges + weekly_spent).

## Kill switch

`wrangler secret delete BEEMINDER_AUTH_TOKEN` — immediate, no deploy, no
config edit. beeminderCharge() returns `failed: beeminder not configured`
from then on. (Flipping LIVE_CHARGING also works but needs a deploy.)

## The rails that must NEVER be weakened

- charge_log row INSERTed BEFORE the fetch (reserve-before-charge)
- `unknown` is terminal and counts in weeklySpentCents — never retryable
- weeklySpentCents counts succeeded + charging + unknown
- a charge that would breach the cap is skipped WHOLE (`capped`)
- test-charge is dry unless `?live=1`
- every amount is read through `chargeCents(env, reason)` — ONE definition, and
  each fallback equals its wrangler.toml var. It was copied in five places with
  two different base values (200 in the judge, 1000 in the admin views and the
  legacy-row reconstruction), so an unset var priced the same failure
  differently depending on which path asked, and `test-charge?live=1` would
  have moved $10 instead of $2. Never let those numbers drift apart again.
