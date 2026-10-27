
import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

const token = process.env.BOT_TOKEN;
const privateGroupId = process.env.PRIVATE_GROUP_ID;
const webhookSecret = process.env.WEBHOOK_SECRET;
const publicUrl = process.env.RENDER_EXTERNAL_URL;
const port = Number(process.env.PORT) || 3000;

if (!token || token === "paste_your_real_token_here") {
  throw new Error("Please configure BOT_TOKEN.");
}

if (!privateGroupId) {
  throw new Error("Please configure PRIVATE_GROUP_ID.");
}

if (!webhookSecret || !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
  throw new Error("Please configure a valid WEBHOOK_SECRET.");
}

if (!publicUrl) {
  throw new Error("RENDER_EXTERNAL_URL is missing. Configure your Render Web Service first.");
}

const bot = new Telegraf(token);
const app = express();
const downloadsDir = path.resolve("downloads");

app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("Telegram poster bot is running!");
});

app.post("/telegram", async (req, res) => {
  if (
    req.header("x-telegram-bot-api-secret-token") !== webhookSecret
  ) {
    res.sendStatus(403);
    return;
  }

  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error("Telegram update error:", error);
    res.sendStatus(500);
  }
});

bot.start(async (ctx) => {
  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");

  await ctx.reply(
    `Welcome, ${name}! 👋\n\nSend me your photo, and I'll turn it into a poster for you.`
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`This chat ID is: ${ctx.chat.id}`);
});

bot.on("photo", async (ctx) => {
  try {
    await fs.mkdir(downloadsDir, { recursive: true });

    await ctx.reply("🎨 Creating your poster...");

    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];

    const fileLink = await ctx.telegram.getFileLink(
      largestPhoto.file_id
    );

    const response = await fetch(fileLink.href);

    if (!response.ok) {
      throw new Error(`Photo download failed: HTTP ${response.status}`);
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    const templatePath = path.resolve("template.png");
    const templateBuffer = await fs.readFile(templatePath);
    const metadata = await sharp(templateBuffer).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error("Could not read template dimensions.");
    }

    const background = await sharp(imageBuffer)
      .rotate()
      .resize(metadata.width, metadata.height, {
        fit: "cover",
        position: "centre",
      })
      .flatten({ background: "#ffffff" })
      .removeAlpha()
      .jpeg({ quality: 95 })
      .toBuffer();

    const posterPath = path.join(
      downloadsDir,
      `poster-${ctx.from.id}.jpg`
    );

    await sharp(background)
      .composite([
        {
          input: templateBuffer,
          blend: "over",
        },
      ])
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 95, mozjpeg: true })
      .toFile(posterPath);

    await ctx.replyWithPhoto(
      { source: posterPath },
      { caption: "✅ Your poster is ready!" }
    );

    console.log(`Poster created for user ${ctx.from.id}`);

    const senderName = ctx.from.username
      ? `@${ctx.from.username}`
      : [ctx.from.first_name, ctx.from.last_name]
          .filter(Boolean)
          .join(" ");

    try {
      await ctx.telegram.sendPhoto(
        privateGroupId,
        largestPhoto.file_id,
        {
          caption: `📩 Photo received from: ${senderName}`,
        }
      );

      console.log(`Original photo forwarded from ${senderName}`);
    } catch (error) {
      console.error("Failed to forward photo to group:", error);

      await ctx.reply(
        "⚠️ Your poster is ready, but I couldn't forward the original photo to the private group."
      );
    }
  } catch (error) {
    console.error("Poster creation error:", error);

    await ctx.reply(
      "❌ I couldn't create your poster. Please try again later."
    );
  }
});

async function startServer() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;

if (!renderUrl) {
  throw new Error("RENDER_EXTERNAL_URL is missing.");
}

const webhookUrl = `${renderUrl.replace(/\/+$/, "")}/telegram`;

  const server = app.listen(port, "0.0.0.0", async () => {
    console.log(`HTTP server listening on port ${port}`);

    try {
      await bot.telegram.setWebhook(webhookUrl, {
        secret_token: webhookSecret,
      });

      console.log(`Telegram webhook configured: ${webhookUrl}`);
      console.log("Poster bot is running!");
    } catch (error) {
      console.error("Failed to configure Telegram webhook:", error);
      server.close(() => process.exit(1));
    }
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
