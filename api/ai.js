// FixFlow AI endpoint (Vercel serverless function).
// POST /api/ai  { action: "analyze" | "escalate" | "inspect" | "deposit", ...payload }
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
    return gemini(
      [
        { inline_data: { mime_type: m[1], data: m[2] } },
        { text: `This is a move-in photo of the "${area || "room"}" in a PG/hostel room. List any existing damage or wear a tenant should document (cracks, stains, broken fittings, seepage, peeling paint, missing items). Be specific about location. If nothing is visible, say so.` },
      ],
      `{"issues": [{"item": string, "location": string, "severity": "Minor"|"Moderate"|"Major"}], "summary": string}`
    );
  },

  async deposit({ deductions, movein, complaints, resident, room, deposit }) {
    return gemini(
      [{ text: `A PG tenant is moving out. Security deposit: Rs ${deposit}. The owner proposes these deductions: ${JSON.stringify(deductions)}.\nDamage documented at move-in (pre-existing, timestamped): ${JSON.stringify(movein)}.\nIssues the tenant reported during the stay: ${JSON.stringify(complaints)}.\nFor each deduction decide: "Unfair" if it matches pre-existing damage or a reported-but-unfixed issue, "Fair" if it looks like genuine tenant damage, "Unclear" otherwise, with a one-line reason. Then write a polite, firm refund request notice to the owner from ${resident}, Room ${room}, asking to refund the disputed amount within 7 days and referencing the move-in evidence.` }],
      `{"items": [{"label": string, "amount": number, "verdict": "Fair"|"Unfair"|"Unclear", "reason": string}], "refund_claim": number, "notice": string}`
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
