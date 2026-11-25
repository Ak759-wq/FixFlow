const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");

initializeApp();
const db = getFirestore();

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
}

function normalizeCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new HttpsError("invalid-argument", "Enter a valid PG code.");
  return code;
}

function toIso(value) {
  if (!value) return null;
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicComplaint(snapshot) {
  const row = snapshot.data();
  return {
    id: snapshot.id,
    title: row.title,
    category: row.category,
    urgency: row.urgency,
    supporters: row.supporters || 1,
    reported_at: toIso(row.reported_at),
  };
}

function wardenComplaint(snapshot) {
  const row = snapshot.data();
  return {
    id: snapshot.id,
    resident_name: row.resident_name,
    room: row.room || null,
    category: row.category,
    urgency: row.urgency,
    title: row.title,
    description: row.description,
    status: row.status,
    supporters: row.supporters || 1,
    reported_at: toIso(row.reported_at),
    fixed_at: toIso(row.fixed_at),
  };
}

async function checkWardenRateLimit(code, request) {
  const ip = request.rawRequest.ip || "unknown";
  const key = crypto.createHash("sha256").update(`${ip}:${code}`).digest("hex");
  const rateRef = db.doc(`wardenRateLimits/${key}`);
  const now = Date.now();
  const snapshot = await rateRef.get();
  const current = snapshot.exists ? snapshot.data() : {};
  const expiresAt = current.expires_at?.toMillis?.() || 0;
  if (expiresAt > now && current.attempts >= 5) {
    throw new HttpsError("resource-exhausted", "Too many incorrect PIN attempts. Try again in 15 minutes.");
  }
}

async function recordWardenFailure(code, request) {
  const ip = request.rawRequest.ip || "unknown";
  const key = crypto.createHash("sha256").update(`${ip}:${code}`).digest("hex");
  const rateRef = db.doc(`wardenRateLimits/${key}`);
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateRef);
    const current = snapshot.exists ? snapshot.data() : {};
    const expiresAt = current.expires_at?.toMillis?.() || 0;
    const active = expiresAt > now;
    transaction.set(rateRef, {
      attempts: active ? (current.attempts || 0) + 1 : 1,
      expires_at: Timestamp.fromMillis(active ? expiresAt : now + 15 * 60 * 1000),
    });
  });
}

async function verifyWarden(codeValue, pinValue, request) {
  const code = normalizeCode(codeValue);
  const pin = String(pinValue || "");
  await checkWardenRateLimit(code, request);
  if (!/^\d{4,8}$/.test(pin)) {
    await recordWardenFailure(code, request);
    return { code, valid: false };
  }
  const credential = await db.doc(`wardenCredentials/${code}`).get();
  const valid = credential.exists && await bcrypt.compare(pin, credential.data().pin_hash);
  if (!valid) await recordWardenFailure(code, request);
  return { code, valid };
}

exports.getPublicStats = onCall(async () => {
  const snapshot = await db.doc("public/stats").get();
  const stats = snapshot.exists ? snapshot.data() : {};
  const fixedCount = stats.fixed_count || 0;
  return {
    open_count: stats.open_count || 0,
    fixed_count: fixedCount,
    avg_days: fixedCount ? Math.round((stats.fixed_days_total || 0) / fixedCount * 10) / 10 : null,
  };
});

exports.listSimilarComplaints = onCall(async (request) => {
  requireAuth(request);
  const code = normalizeCode(request.data?.code);
  const snapshot = await db.collection("complaints").where("pg_code", "==", code).limit(200).get();
  const complaints = snapshot.docs
    .filter((item) => item.data().status !== "fixed")
    .map(publicComplaint)
    .sort((a, b) => b.supporters - a.supporters || new Date(b.reported_at) - new Date(a.reported_at))
    .slice(0, 20);
  return { complaints };
});

exports.supportComplaint = onCall(async (request) => {
  requireAuth(request);
  const id = String(request.data?.id || "");
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new HttpsError("invalid-argument", "Invalid complaint.");
  const complaintRef = db.doc(`complaints/${id}`);
  const supportRef = db.doc(`complaintSupports/${id}_${request.auth.uid}`);
  return db.runTransaction(async (transaction) => {
    const [complaint, support] = await Promise.all([transaction.get(complaintRef), transaction.get(supportRef)]);
    if (!complaint.exists || complaint.data().status === "fixed") {
      throw new HttpsError("failed-precondition", "This complaint is no longer open.");
    }
    if (complaint.data().owner === request.auth.uid) {
      return { supporters: complaint.data().supporters || 1 };
    }
    if (!support.exists) {
      const supporters = (complaint.data().supporters || 1) + 1;
      transaction.update(complaintRef, { supporters });
      transaction.create(supportRef, { owner: request.auth.uid, complaint_id: id, created_at: FieldValue.serverTimestamp() });
      return { supporters };
    }
    return { supporters: complaint.data().supporters || 1 };
  });
});

exports.checkWardenPin = onCall(async (request) => {
  const { code, valid } = await verifyWarden(request.data?.code, request.data?.pin, request);
  return { ok: valid, code };
});

exports.listWardenComplaints = onCall(async (request) => {
  const { code, valid } = await verifyWarden(request.data?.code, request.data?.pin, request);
  if (!valid) throw new HttpsError("unauthenticated", "Wrong PG code or PIN.");
  const snapshot = await db.collection("complaints").where("pg_code", "==", code).limit(500).get();
  return { complaints: snapshot.docs.map(wardenComplaint) };
});

exports.setWardenComplaintStatus = onCall(async (request) => {
  const { code, valid } = await verifyWarden(request.data?.code, request.data?.pin, request);
  if (!valid) throw new HttpsError("unauthenticated", "Wrong PG code or PIN.");
  const id = String(request.data?.id || "");
  const status = String(request.data?.status || "");
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id) || !["in_progress", "fixed"].includes(status)) {
    throw new HttpsError("invalid-argument", "Invalid complaint update.");
  }
  const complaintRef = db.doc(`complaints/${id}`);
  await db.runTransaction(async (transaction) => {
    const complaint = await transaction.get(complaintRef);
    if (!complaint.exists || complaint.data().pg_code !== code) {
      throw new HttpsError("not-found", "Complaint not found in this PG.");
    }
    const fixedAt = status === "fixed" ? FieldValue.serverTimestamp() : null;
    transaction.update(complaintRef, { status, fixed_at: fixedAt });
  });
  return { ok: true };
});

exports.updatePublicStats = onDocumentWritten("complaints/{complaintId}", async (event) => {
  const before = event.data?.before.exists ? event.data.before.data() : null;
  const after = event.data?.after.exists ? event.data.after.data() : null;
  const openCount = (row) => row && row.status !== "fixed" ? 1 : 0;
  const fixedCount = (row) => row?.status === "fixed" ? 1 : 0;
  const fixedDays = (row) => {
    if (row?.status !== "fixed" || !row.reported_at || !row.fixed_at) return 0;
    return Math.max(0, (row.fixed_at.toMillis() - row.reported_at.toMillis()) / 86400000);
  };
  const statsRef = db.doc("public/stats");
  const eventRef = db.doc(`processedStatsEvents/${event.id}`);
  await db.runTransaction(async (transaction) => {
    if ((await transaction.get(eventRef)).exists) return;
    transaction.set(statsRef, {
      open_count: FieldValue.increment(openCount(after) - openCount(before)),
      fixed_count: FieldValue.increment(fixedCount(after) - fixedCount(before)),
      fixed_days_total: FieldValue.increment(fixedDays(after) - fixedDays(before)),
    }, { merge: true });
    transaction.create(eventRef, { expires_at: Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000) });
  });
});
