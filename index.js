import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const userText = message.text;

  // Запрос к OpenAI
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: `Ты умный личный ассистент. Отвечай кратко, по делу и по-человечески.\n\nПользователь: ${userText}`
    })
  });

  const data = await aiResponse.json();

  const reply = data.output_text || "Ошибка ответа";

  // Отправка в Telegram
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

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("Server running");
});
