// Seeds the fictional demo PG (code SUNRISE24, warden PIN 1234) and five sample complaints.
// Uses the Firestore REST API, so it needs no npm packages.
//   Emulator:   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node scripts/seed-demo.mjs demo-fixflow
//   Production: FF_ACCESS_TOKEN=$(gcloud auth print-access-token) node scripts/seed-demo.mjs fixflow-658f3
// (Production writes bypass security rules because they use your Google Cloud credentials.)
const project = process.argv[2] || process.env.FIREBASE_PROJECT_ID;
if (!project) throw new Error("Usage: node scripts/seed-demo.mjs <project-id>");
const emu = process.env.FIRESTORE_EMULATOR_HOST;
const base = emu ? `http://${emu}/v1` : "https://firestore.googleapis.com/v1";
const root = `projects/${project}/databases/(default)/documents`;
const headers = { "Content-Type": "application/json", Authorization: emu ? "Bearer owner" : `Bearer ${process.env.FF_ACCESS_TOKEN}` };
if (!emu && !process.env.FF_ACCESS_TOKEN) throw new Error("Set FF_ACCESS_TOKEN (gcloud auth print-access-token) or FIRESTORE_EMULATOR_HOST.");

const v = (x) => x === null || x === undefined ? { nullValue: null }
  : x instanceof Date ? { timestampValue: x.toISOString() }
  : typeof x === "number" ? (Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x })
  : typeof x === "boolean" ? { booleanValue: x }
  : { stringValue: String(x) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, v(x)]));
const writes = [];
const set = (path, data) => writes.push({ update: { name: `${root}/${path}`, fields: fields(data) } });

const code = "SUNRISE24", now = Date.now(), ago = (d) => new Date(now - d * 864e5);
set(`pgs/${code}`, { code, name: "Sunrise Co-living (demo)", area: "Srinivaspura, Bengaluru" });
set(`pg_secrets/${code}`, { pin: "1234" });
const year = new Date().getFullYear();
const rows = [
  ["demo-wifi", "D0WF", "Rahul (demo)", "108", "Wi-Fi", "Medium", "Wi-Fi drops every evening", "2nd floor router disconnects every evening between 7 PM and 11 PM.", "in_progress", 4, 6, "Technician booked to replace the 2nd floor router"],
  ["demo-geyser", "D0GY", "Sneha (demo)", "302", "Electricity", "High", "Geyser not heating water", "Geyser in room 302 gives only cold water for 3 days.", "open", 2, 3, null],
  ["demo-lock", "D0LK", "Priya (demo)", "110", "Safety", "High", "Room door lock is broken", "Door lock of room 110 does not latch; room cannot be locked at night.", "open", 1, 1, null],
  ["demo-food", "D0FD", "Imran (demo)", "205", "Food", "High", "Insect found in lunch dal", "Insect found in dal served at lunch in the mess.", "fixed", 1, 5, "Mess vessels now covered"],
  ["demo-tap", "D0TP", "Karthik (demo)", "214", "Water", "Low", "Bathroom tap keeps dripping", "Bathroom tap in 214 drips all night.", "fixed", 1, 9, "Washer replaced"],
];
for (const [id, r, name, room, category, urgency, title, description, status, supporters, days, note] of rows) {
  const ref = `FF-${year}-${r}`, reported = ago(days), changed = status === "open" ? reported : ago(days - 1);
  set(`complaints/${id}`, { owner: null, ref, pg_code: code, resident_name: name, room, category, urgency, title, description, draft: null, photo_url: null,
    status, warden_note: note, reported_at: reported, updated_at: changed, fixed_at: status === "fixed" ? changed : null });
  set(`refs/${ref}`, { owner: "seed", complaint: id });
  set(`pgs/${code}/open/${id}`, { owner: "seed", title, category, urgency, status, supporters, reported_at: reported, updated_at: changed });
  set(`complaint_events/${id}-created`, { owner: null, complaint_id: id, kind: "created", from_status: null, to_status: "open", note: null, actor: "system", created_at: reported });
  if (status !== "open") set(`complaint_events/${id}-status`, { owner: null, complaint_id: id, kind: "status", from_status: "open", to_status: status, note, actor: "warden", created_at: changed });
}
const res = await fetch(`${base}/projects/${project}/databases/(default)/documents:commit`, { method: "POST", headers, body: JSON.stringify({ writes }) });
if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }
console.log(`Seeded ${code} (fictional demo PG, warden PIN 1234) with ${rows.length} complaints in ${project}.`);
