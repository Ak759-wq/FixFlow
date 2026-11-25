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
