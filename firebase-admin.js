import admin from "firebase-admin";
import dotenv from "dotenv";
dotenv.config();

// Use service account JSON (you can also set GOOGLE_APPLICATION_CREDENTIALS env)
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY || "{}",
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

export const dbAdmin = admin.firestore();
