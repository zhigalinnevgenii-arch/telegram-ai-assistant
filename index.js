import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PORT = process.env.PORT || 3000;

console.log("ENV CHECK:", {
  hasTelegramToken: !!TELEGRAM_TOKEN,
  hasOpenAiKey: !!OPENAI_KEY,
  hasSupabaseUrl: !!SUPABASE_URL,
  hasSupabaseSecretKey: !!SUPABASE_SECRET_KEY
});

if (!TELEGRAM_TOKEN || !OPENAI_KEY || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error("Missing required Railway Variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

app.get("/", (req, res) => {
  res.status(200).send("Assistant server is running");
});

function extractResponseText(data) {
  if (data.output_text && typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.output)) {
    const texts = [];

    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === "output_text" && content.text) {
            texts.push(content.text);
          }
        }
      }
    }

    if (texts.length > 0) {
      return texts.join("\n").trim();
    }
  }

  return null;
}

async function getEmbedding(text) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text
    })
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(`Embedding error: ${data?.error?.message || "Unknown embedding error"}`);
  }

  return data.data[0].embedding;
}

async function getOrCreateUser(telegramUserId, telegramChatId, displayName) {
  const { data: existingUser, error: selectError } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_user_id", String(telegramUserId))
    .limit(1)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (existingUser) {
    return existingUser;
  }

  const { data: newUser, error: insertError } = await supabase
    .from("users")
    .insert({
      telegram_user_id: String(telegramUserId),
      telegram_chat_id: String(telegramChatId),
      display_name: displayName || null,
      assistant_profile_summary: null,
      last_response_id: null
    })
    .select()
    .single();

  if (insertError) {
    throw insertError;
  }

  return newUser;
}

async function saveMessage(userId, role, text) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      user_id: userId,
      role,
      text
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function saveConversationChunk(userId, messageId, content) {
  const embedding = await getEmbedding(content);

  const { error } = await supabase
    .from("conversation_chunks")
    .insert({
      user_id: userId,
      message_id: messageId,
      content,
      embedding
    });

  if (error) {
    throw error;
  }
}

async function getRecentMessages(userId, limit = 10) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, text, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data || []).reverse();
}

async function searchRelevantChunks(userId, text) {
  const embedding = await getEmbedding(text);

  const { data, error } = await supabase.rpc("match_conversation_chunks", {
    query_embedding: embedding,
    match_user_id: userId,
    match_count: 5
  });

  if (error) {
    console.error("Search error:", error);
    return [];
  }

  return data || [];
}

function buildConversationContext(messages, relevantChunks, currentUserText) {
  const history = messages
    .map((msg) => `${msg.role === "user" ? "Пользователь" : "Ассистент"}: ${msg.text}`)
    .join("\n");

  const memory = relevantChunks
    .map((chunk) => `- ${chunk.content}`)
    .join("\n");

  return `
Ты личный ассистент пользователя.
Отвечай естественно, по-человечески, кратко и по делу.
Учитывай и недавний диалог, и важные релевантные фрагменты из прошлой переписки.
Не говори, что ты не помнишь, если информация уже есть в контексте ниже.

Недавний диалог:
${history || "нет"}

Релевантные воспоминания из прошлой переписки:
${memory || "нет"}

Новое сообщение пользователя:
${currentUserText}
  `.trim();
}

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const telegramUserId = message.from.id;
    const displayName =
      [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") ||
      message.from.username ||
      "User";
    const userText = message.text;

    const user = await getOrCreateUser(telegramUserId, chatId, displayName);

    const savedUserMessage = await saveMessage(user.id, "user", userText);
    await saveConversationChunk(user.id, savedUserMessage.id, userText);

    const recentMessages = await getRecentMessages(user.id, 10);
    const relevantChunks = await searchRelevantChunks(user.id, userText);

    const prompt = buildConversationContext(
      recentMessages,
      relevantChunks,
      userText
    );

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt
      })
    });

    const data = await aiResponse.json();
    let reply = extractResponseText(data);

    if (!reply && data.error?.message) {
      reply = `Ошибка OpenAI: ${data.error.message}`;
    }

    if (!reply) {
      reply = "Ответ пришел, но текст не удалось распознать.";
    }

    const savedAssistantMessage = await saveMessage(user.id, "assistant", reply);
    await saveConversationChunk(user.id, savedAssistantMessage.id, reply);

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);

    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: "Произошла ошибка при обработке сообщения."
          })
        });
      }
    } catch (telegramError) {
      console.error("Telegram fallback error:", telegramError);
    }

    return res.sendStatus(200);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
