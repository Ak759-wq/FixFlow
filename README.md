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
- Resident: tap **Try the demo** (Riya, Room 204: a made-up record; nothing is saved).
- Warden: code `SUNRISE24`, PIN `1234` (seeded fictional complaints; needs the seed script below).

## Stack
Plain HTML/CSS/JS (no build) · Firebase Authentication, Cloud Firestore and Cloud Storage (no Cloud Functions needed) · Vercel serverless function (`/api/ai`) calling Google Gemini (`gemini-3.5-flash-lite`).

## Run locally
```bash
NODE_USE_ENV_PROXY=1 node dev-server.js   # http://localhost:3000
```
Without `GEMINI_API_KEY`, the dev server forwards `/api/ai` to the deployed function. Open `http://localhost:3000/?emu=1` to use the Firebase emulators instead of the real project (localhost only):
```bash
firebase emulators:start --only auth,firestore,storage --project demo-fixflow
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node scripts/seed-demo.mjs demo-fixflow
```

## Deploy (Vercel)
Import the repo, set `GEMINI_API_KEY` (optional `GEMINI_MODEL`) and deploy. `vercel.json` serves `public/` and the `api/` function.

## Tests
`python3 tests/e2e.py http://localhost:3000` — Playwright end-to-end run of every flow against the emulators (88 checks). Against the live URL it runs the landing, demo, privacy and mobile checks; `FF_E2E_BACKEND=1` adds the account journeys once the Firebase project is set up.


## v2 (Nov 25, 2026): tenant accounts + deposit proof
- **Accounts**: Firebase Authentication (email + password or Google sign-in). Tenant records are restricted by Firestore Security Rules to their owner UID.
- **Move-in scan**: per-area photos (bed, wall, bathroom, wardrobe, floor) uploaded to Firebase Storage, Gemini tags pre-existing defects, then **Lock** stamps a server time. Firestore and Storage rules make locked photos read-only, even for the owner.
- **Complaints**: voice/text in any language, AI category + urgency + draft, photo, live unfixed-day counter, +1 on similar issues in the same PG, WhatsApp owner.
- **Deposit claim**: each owner deduction is audited by AI against locked photos and unfixed complaints (fair / unfair / unclear, with the matched photo).
- **Notices**: three escalating drafts (WhatsApp, formal, consumer helpline), editable, saved, one-tap WhatsApp, PDF export.
- **Warden dashboard**: PG code + PIN, PIN-checked Cloud Functions only (no client access to private tables), sorted by status, urgency and residents affected.
- **Demo mode**: Riya's Room 204 record, no sign-up needed (AI calls are real, nothing saved).

## Firebase setup (v3: no Cloud Functions to deploy)
1. Firebase Console → **Authentication** → Sign-in method: enable **Email/Password**, **Google** and **Anonymous** (wardens sign in anonymously, then prove the PG PIN). Settings → Authorized domains: add `fixflow-steel.vercel.app`.
2. **Firestore Database** → Create database (production mode). **Storage** → Get started (default bucket `fixflow-658f3.firebasestorage.app`). Firebase now requires the pay-as-you-go Blaze plan to create a new default Storage bucket; small usage stays inside its no-cost quota. Without Storage, photo uploads fail with a clear error and everything else works.
3. Deploy the rules from this repo (Firebase CLI, signed in): `firebase deploy --only firestore:rules,storage --project fixflow-658f3`. (Or paste `firestore.rules` and `storage.rules` into the console's Rules tabs.) The first time Storage rules read Firestore, the console asks to grant that permission: accept.
4. Seed the fictional demo PG: `FF_ACCESS_TOKEN=$(gcloud auth print-access-token) node scripts/seed-demo.mjs fixflow-658f3` (or create `pgs/SUNRISE24` {name, area} and `pg_secrets/SUNRISE24` {pin: "1234"} by hand in the console).
5. Set `GEMINI_API_KEY` in Vercel.

How access works without Cloud Functions:
- Every tenant document carries `owner`; rules allow only that user to read or write it.
- Locked photos (and their SHA-256), evidence corrections, complaint history and the audit log are append-only in the rules.
- Complaint reference IDs (`FF-YYYY-XXXX`) are made unique by a create-only `refs/{ref}` ledger.
- Wardens: anonymous sign-in + `pgs/{code}/wardens/{uid}` membership, which the rules only allow when the typed PIN matches `pg_secrets/{code}` (unreadable by clients). Members can read and update that PG's complaints and add warden entries to their history.
- "+1 me too": a name-free board `pgs/{code}/open/{complaintId}`; each user can add one supporter doc and bump the count by exactly one.
- Account deletion writes a `deletions/{uid}` tombstone first; only then do the rules allow locked evidence, history and files to be deleted.

The Firebase web config in `public/config.js` is public by design; the rules enforce access. Never commit service-account keys. `functions/` (the earlier Cloud Functions build) is no longer used by the app and doesn't need to be deployed. `supabase/` is kept only as a reference for the old backend.
