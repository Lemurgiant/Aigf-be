import OpenAI from "openai";
import { dbAdmin } from "../firebase-admin.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const sanitizeForLLM = (msg) => {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg === "object" && msg !== null) {
    if ("content" in msg) return String(msg.content);
    if ("text" in msg) return String(msg.text);
    return JSON.stringify(msg);
  }
  return String(msg);
};

export const sanitizeUserId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

export const extractMemory = async (message) => {
  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "Extract important facts about the user. Return JSON array.",
        },
        { role: "user", content: message },
      ],
    });
    return JSON.parse(result.choices[0].message.content);
  } catch {
    return [];
  }
};

export const streamMessage = async (res, model, messages) => {
  const stream = await openai.chat.completions.create({
    model,
    messages,
    stream: true,
  });

  let text = "";
  for await (const event of stream) {
    const chunk = event.choices?.[0]?.delta?.content;
    if (chunk) {
      text += chunk;
      res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
    }
  }

  res.write("data: [DONE]\n\n");
  return text;
};

export const getEmbedding = async (text) => {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
};

const cosineSimilarity = (a, b) => {
  if (!a || !b || a.length === 0 || b.length === 0) return 0; // safe fallback

  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

  if (magA === 0 || magB === 0) return 0;

  return dot / (magA * magB);
};

export const getRelevantMemories = async (userId, message) => {
  const messageEmbedding = await getEmbedding(message);

  const snapshot = await dbAdmin
    .collection("memories")
    .where("userId", "==", userId)
    .get();

  const scored = snapshot.docs.map((doc) => {
    const data = doc.data();
    const score = cosineSimilarity(messageEmbedding, data.embedding);
    return { ...data, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5) // top 5 only
    .map((m) => m.text);
};

export const callLLM = async (model, messages) => {
  const response = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.8, // adjust for creativity
    max_tokens: 500, // max tokens for output
  });

  // The assistant's message is in response.choices[0].message.content
  return response.choices[0].message.content.trim();
};
