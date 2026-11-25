# FixFlow — Report it. Track it. Prove it.

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

## Demo
- Resident: tap **Join your PG**, code `SUNRISE24`.
- Warden: code `SUNRISE24`, PIN `1234`.

## Stack
Plain HTML/CSS/JS (no build) · Supabase Postgres with RLS · Vercel serverless function (`/api/ai`) calling Google Gemini (`gemini-3.5-flash-lite`).

## Run locally
```bash
GEMINI_API_KEY=your_key npm run dev   # http://localhost:3000
```
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
