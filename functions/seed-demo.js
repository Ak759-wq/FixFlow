const bcrypt = require("bcryptjs");
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { Timestamp, getFirestore } = require("firebase-admin/firestore");

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
if (!projectId) throw new Error("Set FIREBASE_PROJECT_ID before seeding the Firebase project.");

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();

async function seed() {
  const code = "SUNRISE24";
  await db.doc(`pgs/${code}`).set({
    code,
    name: "Sunrise Co-living",
    area: "Srinivaspura, Bengaluru",
  });
  await db.doc(`wardenCredentials/${code}`).set({
    pin_hash: await bcrypt.hash("1234", 12),
  });

  const now = Date.now();
  const complaints = [
    { id: "demo-wifi", resident_name: "Rahul", room: "108", category: "Wi-Fi", urgency: "Medium", title: "Wi-Fi drops every evening", description: "2nd floor router disconnects every evening between 7 PM and 11 PM.", status: "in_progress", supporters: 4, days: 6, fixedDaysAgo: null },
    { id: "demo-geyser", resident_name: "Sneha", room: "302", category: "Electricity", urgency: "High", title: "Geyser not heating water", description: "Geyser in room 302 gives only cold water for 3 days.", status: "open", supporters: 2, days: 3, fixedDaysAgo: null },
    { id: "demo-lock", resident_name: "Priya", room: "110", category: "Safety", urgency: "High", title: "Room door lock is broken", description: "Door lock of room 110 does not latch; room cannot be locked at night.", status: "open", supporters: 1, days: 1, fixedDaysAgo: null },
    { id: "demo-food", resident_name: "Imran", room: "205", category: "Food", urgency: "High", title: "Insect found in lunch dal", description: "Insect found in dal served at lunch in the mess.", status: "fixed", supporters: 1, days: 5, fixedDaysAgo: 4 },
    { id: "demo-tap", resident_name: "Karthik", room: "214", category: "Water", urgency: "Low", title: "Bathroom tap keeps dripping", description: "Bathroom tap in 214 drips all night.", status: "fixed", supporters: 1, days: 9, fixedDaysAgo: 6 },
  ];

  const batch = db.batch();
  for (const complaint of complaints) {
    const reported = Timestamp.fromMillis(now - complaint.days * 86400000);
    const fixed = complaint.fixedDaysAgo === null ? null : Timestamp.fromMillis(now - complaint.fixedDaysAgo * 86400000);
    batch.set(db.doc(`complaints/${complaint.id}`), {
      owner: null,
      pg_code: code,
      resident_name: complaint.resident_name,
      room: complaint.room,
      category: complaint.category,
      urgency: complaint.urgency,
      title: complaint.title,
      description: complaint.description,
      draft: null,
      photo_url: null,
      photo_path: null,
      status: complaint.status,
      warden_note: null,
      supporters: complaint.supporters,
      reported_at: reported,
      fixed_at: fixed,
    });
  }
  const statsRef = db.doc("public/stats");
  if (!(await statsRef.get()).exists) {
    batch.set(statsRef, { open_count: 0, fixed_count: 0, fixed_days_total: 0 });
  }
  await batch.commit();
  console.log("Seeded Sunrise Co-living (PG code SUNRISE24, warden PIN 1234).");
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
