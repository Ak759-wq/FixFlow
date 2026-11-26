# FixFlow — Your PG. Your Proof. Your Deposit Protected.

_Report it. Track it. Prove it._

AI complaint copilot for PG and hostel residents in India. Built for **PromptWars × Echo Engineers AI VIBEATHON 2026**.

## The problem
Complaints in PGs and hostels are made over WhatsApp or in person, so they get ignored, leave no record, and can't be escalated. At move-out, owners deduct deposits for damage that was already there. Wardens juggle scattered complaints with no way to prioritise.

## What FixFlow does
- **Report in your words** — Hindi, English or Hinglish, by voice (Web Speech API) or text. Gemini sets the category and urgency and drafts a formal complaint.
- **Group complaints** — if others in the PG reported the same issue, add your support so it rises in priority.
- **Unfixed-days counter + 3-step escalation** — WhatsApp reminder → formal notice → consumer-complaint draft (National Consumer Helpline).
- **Warden dashboard** — complaints sorted by urgency and group size, category chart, one-tap *Start work* / *Mark fixed* with notes.
- **Move-in proof** — timestamped, locked room photos; Gemini Vision lists existing damage.
- **Deposit check** — compares the owner's deductions with move-in evidence and complaint history, flags unfair ones and drafts a refund notice.

Works offline-first for AI: if Gemini is unreachable, a rule-based classifier and templates keep every flow working.

## Demo (fictional data)
- Resident: tap **Try the demo** (Riya, Room 204 — a made-up record; nothing is saved).
- Warden: code `SUNRISE24`, PIN `1234` (seeded fictional complaints).

## Stack
Plain HTML/CSS/JS (no build) · Supabase Postgres with RLS · Vercel serverless function (`/api/ai`) calling Google Gemini (`gemini-3.5-flash-lite`).

## Run locally
```bash
NODE_USE_ENV_PROXY=1 node dev-server.js   # http://localhost:3000
```
With `GEMINI_API_KEY` set, `/api/ai` runs locally; without it, the dev server forwards `/api/ai` to the deployed function so you don't need a key.
Database schema: `supabase/schema.sql` (seed: `supabase/seed.sql`). Public config in `public/config.js`.

## Deploy (Vercel)
Import the repo, set `GEMINI_API_KEY` (optional `GEMINI_MODEL`) and deploy. `vercel.json` serves `public/` and the `api/` function.

## Tests
`python3 tests/e2e.py http://localhost:3000` — Playwright end-to-end run of every flow (28 checks).


## v2 (Nov 25, 2026): tenant accounts + deposit proof
- **Accounts**: Supabase Auth (email + password). Every tenant row is private by RLS (`owner = auth.uid()`).
- **Move-in scan**: per-area photos (bed, wall, bathroom, wardrobe, floor) uploaded to Supabase Storage, Gemini tags pre-existing defects, then **Lock** stamps a server time. A DB trigger makes locked photos read-only, even for the owner.
- **Complaints**: voice/text in any language, AI category + urgency + draft, photo, live unfixed-day counter, +1 on similar issues in the same PG, WhatsApp owner.
- **Deposit claim**: each owner deduction is audited by AI against locked photos and unfixed complaints (fair / unfair / unclear, with the matched photo).
- **Notices**: three escalating drafts (WhatsApp, formal, consumer helpline), editable, saved, one-tap WhatsApp, PDF export.
- **Warden dashboard**: PG code + PIN, PIN-checked RPCs only (no table access), sorted by status, urgency and residents affected.
- **Demo mode**: Riya's Room 204 record, no sign-up needed (AI calls are real, nothing saved).

Setup: run `supabase/schema.sql` then `supabase/seed.sql`. Turn on "Confirm email: off" (or keep it on for production). Set `GEMINI_API_KEY` in Vercel.
Tests: `python3 tests/e2e.py [url]` (40 checks). Cleanup: `supabase/cleanup_tests.sql`.


## v3 (Nov 26, 2026): evidence you can defend
- **Landing**: "Your PG. Your Proof. Your Deposit Protected." with CTAs on first view; 3-step flow (Move-in evidence → Complaint tracking → Deposit protection); only verifiable facts (Model Tenancy Act, 2021 s.11 via MoHUA; National Consumer Helpline 1915). Unsourced numbers and live demo counters removed.
- **PG details dashboard**: deposit front and centre, PG/owner details, refund position, next steps, recent activity, last-updated. Tabs: PG details, Move-in scan, Complaints, Deposit audit, Notices. Loading skeleton and error/retry state.
- **Move-in evidence**: areas Bedroom / Bathroom / Walls / Furniture (old `wardrobe`/`floor` rows still display and count). JPEG/PNG/WebP up to 10 MB. Review step before saving (preview, file facts, client-side **SHA-256**). Original file stored; hash, size, type, last-modified saved in `ff_photos`. Edit the AI description before lock; confirmation tick before lock. Locked rows (incl. hash) are read-only by trigger and their files can't be deleted from storage by the tenant. Corrections are new dated rows in `ff_evidence_notes`. Downloadable evidence report (PDF) with hashes, times, corrections, photos and history.
- **Complaints**: voice (Web Speech API, with fallback message) or text; AI suggests category/urgency/description, all editable; photo attachment with validation; reference IDs `FF-YYYY-NNNN`; submission + last-updated dates; status history in `ff_complaint_events` (created, status changes by resident or warden, warden notes, replies the tenant logs). Status labels Open / In progress / Resolved.
- **Deposit audit**: original deposit, deductions, AI audit against locked photos **and** complaints (linked photo with hash + linked complaint ref), tenant can Dispute/Accept each line, disputed total, refund due, alerts (deductions > deposit, deposit > 2 months' rent under the MTA model law, no locked photos), "Generate dispute notice", not-legal-advice disclaimer. Rule-based fallback when AI is down.
- **Notices**: editable drafts, preview with annexes (evidence + hashes, complaint refs, deductions), review tick → "final" (read-only until reopened), per-notice and full-pack PDF (marked DRAFT until final).
- **Privacy**: `/privacy` page (Google consent-screen link), JSON export of all own records, delete account + data (`ff_purge_my_data` → Storage API removal → `ff_delete_my_account`), append-only `ff_audit_log` written by triggers (users can read, never write).

Schema changes are additive: `supabase/v3_migration.sql` (also appended to `schema.sql`, which is now idempotent and no longer drops `ff_complaints`).
Tests: `python3 tests/e2e.py [url]` (88 checks). Cleanup: `supabase/cleanup_tests.sql`, then `supabase/seed.sql`.
