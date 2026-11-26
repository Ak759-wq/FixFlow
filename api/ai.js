// FixFlow AI endpoint (Vercel serverless function).
// POST /api/ai  { action: "analyze" | "inspect" | "audit" | "notices", ...payload }
// Uses Google Gemini. Set GEMINI_API_KEY (and optionally GEMINI_MODEL) in the environment.

const MODELS = [process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-flash-lite-latest"].filter(Boolean);

const CATEGORIES = ["Water", "Electricity", "Wi-Fi", "Food", "Hygiene", "Safety", "Maintenance", "Other"];

const PER_MODEL_MS = 12000;

async function gemini(parts, schemaHint) {
  const key = process.env.GEMINI_API_KEY || "";
  if (!key) throw Object.assign(new Error("AI is not configured on this server"), { status: 503 });
  let lastErr;
  for (const model of MODELS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PER_MODEL_MS);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
            systemInstruction: {
              parts: [{ text: "You are FixFlow, an assistant for residents of PGs and hostels in India. Always reply with valid JSON only, matching this shape: " + schemaHint }],
            },
          }),
        }
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      return JSON.parse(text.replace(/^```json|```$/g, "").trim());
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("AI timed out") : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(new Error("AI is temporarily unavailable"), { status: 503, cause: lastErr });
}

const handlers = {
  async analyze({ text, resident, room, pg }) {
    if (!text || text.trim().length < 3) throw Object.assign(new Error("Describe the issue first"), { status: 400 });
    text = String(text).slice(0, 2000);
    const out = await gemini(
      [{ text: `Resident: ${resident || "Resident"}, Room ${room || "-"}, PG: ${pg || "-"}.\nComplaint (may be Hindi, English or Hinglish): """${text}"""\n\nClassify it. category must be one of ${CATEGORIES.join(", ")}. urgency: High if health, safety, no water, no power or security risk; Medium if it blocks daily life (Wi-Fi, food quality, broken fittings); Low for cosmetic or minor. Write a short English title (max 8 words), a one-line summary, a clear factual description in English for the complaint record (1-2 sentences, keep every concrete detail like room, times and how long; do not invent facts), and a polite, firm formal complaint to the warden in English (60-110 words) that states the issue, since when, impact, and requests a fix with a reasonable timeline. Sign it with the resident name and room.` }],
      `{"category": string, "urgency": "High"|"Medium"|"Low", "title": string, "summary": string, "description": string, "draft": string}`
    );
    if (!CATEGORIES.includes(out.category)) out.category = "Other";
    if (!["High", "Medium", "Low"].includes(out.urgency)) out.urgency = "Medium";
    return out;
  },

  async escalate({ complaint, level, days }) {
    const stage = ["a friendly WhatsApp reminder to the warden (2-3 short lines, polite)", "a formal written notice to the PG owner citing the complaint date and days unresolved, requesting resolution within 48 hours", "a draft consumer complaint for the National Consumer Helpline (consumerhelpline.gov.in / 1915) describing deficiency in service, timeline, and relief sought"][Math.min(Math.max(level, 1), 3) - 1];
    return gemini(
      [{ text: `Write ${stage}.\nComplaint: ${complaint.title}. Details: ${complaint.text}. Category: ${complaint.category}. Raised on ${complaint.created_at?.slice(0, 10)}, unresolved for ${days} days. Resident: ${complaint.resident_name}, Room ${complaint.room}.` }],
      `{"message": string}`
    );
  },

  async inspect({ image, area }) {
    const m = /^data:(image\/\w+);base64,(.+)$/.exec(image || "");
    if (!m) throw Object.assign(new Error("Invalid image"), { status: 400 });
    if (m[2].length > 6_000_000) throw Object.assign(new Error("Image too large"), { status: 413 });
    const out = await gemini(
      [
        { inline_data: { mime_type: m[1], data: m[2] } },
        { text: `This is a move-in photo of the "${area || "room"}" in a PG/hostel room in India. A tenant is documenting damage that already exists before they move in. List each visible pre-existing defect as a short lowercase tag (2-4 words, e.g. "water stain", "loose hinge", "peeling plaster", "hard water scaling"). Then write one or two factual sentences describing each defect, its rough size and where it is, so it can serve as a move-in record. If the photo is not of a room, or nothing is damaged, return an empty tags list and say so.` },
      ],
      `{"tags": string[], "summary": string}`
    );
    out.tags = Array.isArray(out.tags) ? out.tags.slice(0, 8).map(String) : [];
    out.summary = String(out.summary || "");
    return out;
  },

  async audit({ deductions, photos, complaints, deposit }) {
    if (!Array.isArray(deductions) || !deductions.length) throw Object.assign(new Error("No deductions"), { status: 400 });
    const out = await gemini(
      [{ text: `A PG tenant in India is moving out. Security deposit: Rs ${deposit}.
Locked, timestamped move-in photos (damage that already existed at move-in): ${JSON.stringify(photos || []).slice(0, 12000)}
Complaints the tenant logged during the stay (with reference IDs and status): ${JSON.stringify(complaints || []).slice(0, 8000)}
The owner wants to deduct: ${JSON.stringify(deductions).slice(0, 6000)}

For EACH deduction (keep its id) decide:
- "unfair" if the damage it charges for already appears in a move-in photo, or comes from a complaint the PG never resolved. Set matchedPhotoId to the matching photo id and/or matchedComplaintId to the matching complaint id.
- "fair" if it is a normal, itemised, reasonable charge (e.g. agreed cleaning fee) or genuine tenant damage not covered by the evidence.
- "unclear" if it is vague, unitemised or needs a bill. Set matchedComplaintId if a complaint is related.
Give a one or two sentence reason addressed to the tenant that cites the specific evidence (photo area and lock date, or complaint reference ID and date). Never invent evidence that is not listed. Use "" for ids that don't apply.` }],
      `{"results": [{"id": string, "verdict": "fair"|"unfair"|"unclear", "reason": string, "matchedPhotoId": string, "matchedComplaintId": string}]}`
    );
    return { results: Array.isArray(out.results) ? out.results : [] };
  },

  async notices({ tenant, tenancy, photos, complaints, deductions, disputed, today }) {
    if (!tenancy?.pg_name) throw Object.assign(new Error("Missing tenancy"), { status: 400 });
    return gemini(
      [{ text: `Write three escalating messages from a PG tenant to their PG owner, in clear, calm, firm English.
Tenant: ${tenant}. PG: ${tenancy.pg_name}, ${tenancy.address || "Bengaluru"}. Room: ${tenancy.room}. Owner/warden: ${tenancy.owner_name || "Sir/Madam"}.
Monthly rent Rs ${tenancy.monthly_rent}, security deposit Rs ${tenancy.deposit}. Move-in ${tenancy.move_in}, move-out ${tenancy.move_out || "upcoming"}.
Today's date: ${today || "today"}.
Evidence: locked move-in photos (with SHA-256 fingerprint prefixes) -> ${JSON.stringify(photos).slice(0, 8000)}. Complaints with reference IDs -> ${JSON.stringify(complaints).slice(0, 6000)}.
Deductions, audit findings and the tenant's position -> ${JSON.stringify(deductions).slice(0, 6000)}. Amount the tenant disputes: Rs ${disputed} (only the deductions where tenantPosition is "dispute").

1. whatsapp: a friendly but firm WhatsApp message (60-90 words) asking for the disputed amount back within 7 days, mentioning the dated move-in photos.
2. formal: a formal written notice (170-260 words) with a subject line, today's date, tenancy dates, each disputed deduction with its amount and the evidence that contradicts it (photo area and lock date, complaint reference IDs), a 7-day deadline and a request for itemised bills for anything else.
3. grievance: a draft complaint for the National Consumer Helpline (1915 / consumerhelpline.gov.in) describing deficiency in service, the timeline, the evidence, and the relief sought (refund of Rs ${disputed}).
Use only the facts given; do not invent dates, amounts, laws or reference numbers. Do not threaten legal action beyond the consumer helpline.` }],
      `{"whatsapp": string, "formal": string, "grievance": string}`
    );
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }
  const fn = handlers[body.action];
  if (!fn) return res.status(400).json({ error: "Unknown action" });
  try {
    const result = await fn(body);
    res.status(200).json({ ...result, source: "gemini" });
  } catch (e) {
    // The client falls back to rule-based results when it gets an error.
    res.status(e.status || 500).json({ error: String(e.message || e), fallback: true });
  }
}
