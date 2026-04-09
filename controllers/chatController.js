import { characters } from "../const/characters.js";
import { dbAdmin } from "../firebase-admin.js";
import {
  callLLM,
  extractMemory,
  getEmbedding,
  getRelevantMemories,
  sanitizeForLLM,
  sanitizeUserId,
  streamMessage,
} from "./chat-utils.js";

const summarizeHistory = async (messages, existingSummary = "") => {
  const summaryPrompt = [
    {
      role: "system",
      content: `You summarize conversations for memory compression.
Keep it short but preserve:
- Important facts about the user
- Ongoing topics
- Key context needed to continue the conversation

Existing summary:
${existingSummary}`,
    },
    {
      role: "user",
      content: `Summarize the following conversation:\n\n${messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")}`,
    },
  ];

  const summary = await callLLM("gpt-4.1", summaryPrompt);
  return summary;
};

export const chat = async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const { message, character, conversationId, userId } = req.body;

    const safeUserId = sanitizeUserId(userId);

    const convoRef = dbAdmin
      .collection("conversations")
      .doc(conversationId)
      .collection("messages");

    const convoDocRef = dbAdmin.collection("conversations").doc(conversationId);

    const selectedCharacter = characters[character] || characters.luna;

    /* ---------------- LOAD HISTORY ---------------- */

    const snapshot = await convoRef
      .orderBy("createdAt", "desc") // newest first
      .limit(50)
      .get();

    let fullHistory = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        role: String(data.role || "user"),
        content: sanitizeForLLM(data.content),
      };
    });

    // reverse to chronological order

    const isGreeting = /^(hi|hello|hey)$/i.test(message.trim());
    /* ---------------- SPLIT HISTORY ---------------- */

    const MAX_RECENT = 1;

    const recentMessages = isGreeting ? fullHistory.slice(-MAX_RECENT) : [];
    const oldMessages = fullHistory.slice(0, -MAX_RECENT);

    fullHistory = fullHistory.reverse();

    /* ---------------- LOAD SUMMARY ---------------- */

    const convoDoc = await convoDocRef.get();
    let summary = convoDoc.exists ? convoDoc.data().summary || "" : "";

    /* ---------------- CONDITIONAL SUMMARIZATION ---------------- */

    if (oldMessages.length > 0) {
      summary = await summarizeHistory(oldMessages, summary);

      await convoDocRef.set({ summary }, { merge: true });
    }

    /* ---------------- SEMANTIC MEMORY ---------------- */

    const memories = await getRelevantMemories(safeUserId, message);

    const memoryPrompt = memories.length
      ? `Relevant things you remember about the user:\n- ${memories.join("\n- ")}`
      : "";

    /* ---------------- SAVE USER MESSAGE ---------------- */

    await convoRef.add({
      role: "user",
      content: message,
      createdAt: Date.now(),
    });

    const now = Date.now();

    const lastMessage = snapshot.docs[0]?.data(); // newest (because desc)
    const lastTimestamp = lastMessage?.createdAt || now;

    const timeDiffMs = now - lastTimestamp;

    const minutes = Math.floor(timeDiffMs / 60000);
    const hours = Math.floor(timeDiffMs / 3600000);
    const days = Math.floor(timeDiffMs / 86400000);

    let timeContext = "";

    if (minutes < 2) {
      timeContext = "The user just replied almost immediately.";
    } else if (minutes < 30) {
      timeContext = "The user replied after a short while.";
    } else if (hours < 6) {
      timeContext = "The user was gone for a few hours.";
    } else if (hours < 24) {
      timeContext = "The user was gone for most of the day.";
    } else if (days < 3) {
      timeContext = "The user has been gone for a day or two.";
    } else {
      timeContext = "The user has been gone for a long time.";
    }

    const shouldMentionTime = timeDiffMs > 1000 * 60 * 10; // 10+ minutes ONLY

    const timeMessage = shouldMentionTime
      ? [
          {
            role: "system",
            content: `
Time context: ${timeContext}

Behavior:
- you may softly acknowledge the time gap
- keep it subtle and emotional
- do not force it
`,
          },
        ]
      : [];

    /* ---------------- BUILD PROMPT ---------------- */

    const baseMessages = [
      {
        role: "system",
        content: selectedCharacter.getSystemPrompt(10),
      },
      ...timeMessage,
      ...(summary
        ? [
            {
              role: "system",
              content: `Conversation summary:\n${summary}`,
            },
          ]
        : []),
      ...(memoryPrompt
        ? [
            {
              role: "system",
              content: memoryPrompt,
            },
          ]
        : []),
      ...recentMessages,
      { role: "user", content: message },
    ];

    console.log(recentMessages);
    console.log("summary", summary);

    /* ---------------- FIRST MESSAGE ---------------- */

    res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);

    const firstMsg = await streamMessage(res, "gpt-4.1", baseMessages);

    await convoRef.add({
      role: "assistant",
      content: firstMsg,
      createdAt: Date.now(),
    });

    res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);

    /* ---------------- OPTIONAL SECOND MESSAGE ---------------- */

    const doubleMessage = Math.random() < 0.6;

    if (doubleMessage) {
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));

      res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);

      const secondMsg = await streamMessage(res, "gpt-4.1", [
        ...baseMessages,
        { role: "assistant", content: firstMsg },
        {
          role: "user",
          content: "Write a short follow-up comment to continue naturally.",
        },
      ]);

      await convoRef.add({
        role: "assistant",
        content: secondMsg,
        createdAt: Date.now(),
      });

      res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
    }

    /* ---------------- MEMORY EXTRACTION ---------------- */

    const memoriesFound = await extractMemory(message);

    for (const mem of memoriesFound) {
      const embedding = await getEmbedding(mem);

      await dbAdmin.collection("memories").add({
        userId: safeUserId,
        text: mem,
        embedding,
        createdAt: Date.now(),
      });
    }

    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    res.end();
  }
};
/* ---------------- LOAD CONVERSATION ---------------- */

export const loadConversation = async (req, res) => {
  const { conversationId } = req.query;

  if (!conversationId)
    return res.status(400).json({ error: "Missing conversationId" });

  try {
    const snapshot = await dbAdmin
      .collection("conversations")
      .doc(conversationId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(150)
      .get();

    const messages = snapshot.docs.map((doc) => doc.data()).reverse();

    res.json({ messages });
  } catch (err) {
    console.error("Load conversation error:", err);
    res.status(500).json({ error: "Failed to load conversation" });
  }
};
