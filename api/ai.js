// FixFlow AI endpoint (Vercel serverless function).
// POST /api/ai  { action: "analyze" | "inspect" | "audit" | "notices", ...payload }
// Uses Google Gemini. Set GEMINI_API_KEY (and optionally GEMINI_MODEL) in the environment.

const MODELS = [process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-flash-lite-latest"].filter(Boolean);

const CATEGORIES = ["Water", "Electricity", "Wi-Fi", "Food", "Hygiene", "Safety", "Maintenance", "Other"];

async function gemini(parts, schemaHint) {
  const key = process.env.GEMINI_API_KEY || "";
  let lastErr;
  for (const model of MODELS) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(key ? { "x-goog-api-key": key } : {}) },
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
      lastErr = e;
    }
  }
  throw lastErr || new Error("AI unavailable");
}

const handlers = {
  async analyze({ text, resident, room, pg }) {
    if (!text || text.trim().length < 3) throw new Error("Describe the issue first");
    const out = await gemini(
      [{ text: `Resident: ${resident || "Resident"}, Room ${room || "-"}, PG: ${pg || "-"}.\nComplaint (may be Hindi, English or Hinglish): """${text}"""\n\nClassify it. category must be one of ${CATEGORIES.join(", ")}. urgency: High if health, safety, no water, no power or security risk; Medium if it blocks daily life (Wi-Fi, food quality, broken fittings); Low for cosmetic or minor. Write a short English title (max 8 words), a one-line summary, and a polite, firm formal complaint to the warden in English (60-110 words) that states the issue, since when, impact, and requests a fix with a reasonable timeline. Sign it with the resident name and room.` }],
      `{"category": string, "urgency": "High"|"Medium"|"Low", "title": string, "summary": string, "draft": string}`
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
    if (!m) throw new Error("Invalid image");
    const out = await gemini(
      [
        { inline_data: { mime_type: m[1], data: m[2] } },
        { text: `This is a move-in photo of the "${area || "room"}" in a PG/hostel room in India. A tenant is documenting damage that already exists before they move in. List each visible pre-existing defect as a short lowercase tag (2-4 words, e.g. "water stain", "loose hinge", "peeling plaster", "hard water scaling"). Then write one factual sentence describing the defects and where they are. If the photo is not of a room, or nothing is damaged, return an empty tags list and say so.` },
      ],
      `{"tags": string[], "summary": string}`
    );
    out.tags = Array.isArray(out.tags) ? out.tags.slice(0, 8).map(String) : [];
    out.summary = String(out.summary || "");
    return out;
  },

  async audit({ deductions, photos, complaints, deposit }) {
    const out = await gemini(
      [{ text: `A PG tenant in Bengaluru is moving out. Security deposit: Rs ${deposit}.
Locked, timestamped move-in photos (pre-existing damage): ${JSON.stringify(photos)}
Issues the tenant reported during the stay that the PG did not fix: ${JSON.stringify(complaints)}
The owner wants to deduct: ${JSON.stringify(deductions)}

For EACH deduction (keep its id) decide:
- "unfair" if the damage it charges for already appears in a move-in photo, or comes from a reported issue the PG never fixed. Set matchedPhotoId to the matching photo id when there is one.
- "fair" if it is a normal, itemised, reasonable charge (e.g. agreed cleaning fee) or genuine tenant damage.
- "unclear" if it is vague, unitemised or needs a bill.
Give a one or two sentence reason addressed to the tenant ("Your locked move-in wall photo ...").` }],
      `{"results": [{"id": string, "verdict": "fair"|"unfair"|"unclear", "reason": string, "matchedPhotoId": string}]}`
    );
    return { results: Array.isArray(out.results) ? out.results : [] };
  },

  async notices({ tenant, tenancy, photos, complaints, deductions, disputed }) {
    return gemini(
      [{ text: `Write three escalating messages from a PG tenant to their PG owner, in clear, calm, firm English.
Tenant: ${tenant}. PG: ${tenancy.pg_name}, ${tenancy.address || "Bengaluru"}. Room: ${tenancy.room}. Owner/warden: ${tenancy.owner_name || "Sir/Madam"}.
Monthly rent Rs ${tenancy.monthly_rent}, security deposit Rs ${tenancy.deposit}. Move-in ${tenancy.move_in}, move-out ${tenancy.move_out || "upcoming"}.
Evidence: locked move-in photos -> ${JSON.stringify(photos)}. Unfixed complaints -> ${JSON.stringify(complaints)}.
Deductions and AI verdicts -> ${JSON.stringify(deductions)}. Amount the tenant disputes: Rs ${disputed}.

1. whatsapp: a friendly but firm WhatsApp message (60-90 words) asking for the disputed amount back within 7 days, mentioning the dated move-in photos.
2. formal: a formal written notice (150-220 words) with a subject line, dates, each disputed deduction with the reason, a 7-day deadline and a request for itemised bills for anything else.
3. grievance: a draft complaint for the National Consumer Helpline (1915 / consumerhelpline.gov.in) describing deficiency in service, the timeline, the evidence, and the relief sought (refund of Rs ${disputed}).
Use only the facts given; do not invent dates or amounts.` }],
      `{"whatsapp": string, "formal": string, "grievance": string}`
    );
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const fn = handlers[body.action];
    if (!fn) return res.status(400).json({ error: "Unknown action" });
    const result = await fn(body);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
