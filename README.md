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
Plain HTML/CSS/JS (no build) · Firebase Authentication, Cloud Firestore, Cloud Storage and Cloud Functions · Vercel serverless function (`/api/ai`) calling Google Gemini (`gemini-3.5-flash-lite`).

## Run locally
```bash
GEMINI_API_KEY=your_key npm run dev   # http://localhost:3000
```
Firebase web app settings go in `public/config.js`. Firestore and Storage access rules, indexes and Cloud Functions are in the repository root and `functions/`.

## Deploy (Vercel)
Import the repo, set `GEMINI_API_KEY` (optional `GEMINI_MODEL`) and deploy. `vercel.json` serves `public/` and the `api/` function.

## Tests
`python3 tests/e2e.py http://localhost:3000` — Playwright end-to-end run of every flow.


## v2 (Nov 25, 2026): tenant accounts + deposit proof
- **Accounts**: Firebase Authentication (email + password or Google sign-in). Tenant records are restricted by Firestore Security Rules to their owner UID.
- **Move-in scan**: per-area photos (bed, wall, bathroom, wardrobe, floor) uploaded to Firebase Storage, Gemini tags pre-existing defects, then **Lock** stamps a server time. Firestore and Storage rules make locked photos read-only, even for the owner.
- **Complaints**: voice/text in any language, AI category + urgency + draft, photo, live unfixed-day counter, +1 on similar issues in the same PG, WhatsApp owner.
- **Deposit claim**: each owner deduction is audited by AI against locked photos and unfixed complaints (fair / unfair / unclear, with the matched photo).
- **Notices**: three escalating drafts (WhatsApp, formal, consumer helpline), editable, saved, one-tap WhatsApp, PDF export.
- **Warden dashboard**: PG code + PIN, PIN-checked Cloud Functions only (no client access to private tables), sorted by status, urgency and residents affected.
- **Demo mode**: Riya's Room 204 record, no sign-up needed (AI calls are real, nothing saved).

## Firebase setup
1. In Firebase project `fixflow-658f3`, register a Web app if needed. Copy its complete public config values (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`) into `FIREBASE_CONFIG` in `public/config.js`; the project ID and default auth domain are already filled in.
2. In Firebase Authentication, enable **Email/Password** and **Google** providers. Add `localhost` and the deployed site domain to Authorized domains.
3. Create a Cloud Firestore database and a Cloud Storage bucket.
4. Enable billing for Cloud Functions, install Firebase CLI, sign in, and select the project with `firebase use --add`. Install Functions dependencies with `npm --prefix functions install`.
5. Deploy the security rules, indexes and backend functions: `firebase deploy --only firestore:rules,firestore:indexes,storage,functions`.
6. To seed the example PG and warden data, authenticate Application Default Credentials and run `FIREBASE_PROJECT_ID=your-project-id npm --prefix functions run seed-demo`. The demo PG code is `SUNRISE24`; its sample warden PIN is `1234`.
7. Set `GEMINI_API_KEY` in Vercel as before. Set `FUNCTIONS_REGION` in `public/config.js` if deploying Functions outside `us-central1`.

The Firebase web config is public; Firestore and Storage Security Rules enforce data access. Never put service-account keys in `public/config.js` or commit them. The app now uses Firebase at runtime; existing records in the old Supabase project are not copied automatically. The `supabase/` directory retains the old schema/seed files only as a reference for any separately credentialed data export.

Tests: `python3 tests/e2e.py [url]` (requires the configured Firebase project, deployed Functions/rules, and Playwright).
