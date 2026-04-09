import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import chatRoutes from "./routes/chat.js";
import OpenAI from "openai";
import "./firebase.js";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
  }),
);
app.use(express.json());
app.use("/chat", chatRoutes);

// ✅ Export app as default for serverless
export default app;
