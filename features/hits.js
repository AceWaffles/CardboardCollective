// features/hits.js
const path = require("path");
const { EmbedBuilder } = require("discord.js");
const { readJson, writeJson } = require("../utils/jsonStore");

const DB_PATH = path.join(__dirname, "..", "data", "hits.json");

function normalize(str) {
  return (str || "").trim();
}

async function ask(dm, question) {
  await dm.send(question);
  const collected = await dm.awaitMessages({
    max: 1,
    time: 2 * 60 * 1000,
    errors: ["time"]
  });
  return collected.first();
}

function createHitsFeature({ config, client }) {
  async function handleMessage(message) {
    const lower = message.content.trim().toLowerCase();
    if (lower !== "mw hit") return false;

    const hitsChannelId = config?.hits?.hitsChannelId;
    if (!hitsChannelId) {
      await message.reply("⚠️ Hits are not configured yet (missing `hits.hitsChannelId` in config.json).");
      return true;
    }

    let dm;
    try {
      dm = await message.author.createDM();
      await dm.send("🔥 **Hit Post Wizard**\nType `cancel` anytime to stop.");
    } catch {
      await message.reply("⚠️ I couldn’t DM you. Please enable DMs from server members and try again.");
      return true;
    }

    const qTitle = await ask(dm, "1) What’s the hit? (short title)\nExample: `Wolverine /99 Color Match`");
    const title = normalize(qTitle.content);
    if (!title || title.toLowerCase() === "cancel") return true;

    await dm.send("2) Send **one photo** of the hit (attach an image).");
    const qPhoto = await dm.awaitMessages({ max: 1, time: 2 * 60 * 1000, errors: ["time"] });
    const msg = qPhoto.first();
    const attach = [...msg.attachments.values()].find(a =>
      a.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(a.url)
    );

    if (!attach) {
      await dm.send("⚠️ No image detected. Start again with `mw hit`.");
      return true;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔥 HIT: ${title}`)
      .setDescription(`Posted by <@${message.author.id}>`)
      .setImage(attach.url)
      .setFooter({ text: "Cardboard Collective • Hits Feed" })
      .setTimestamp(new Date());

    const hitsChannel = await client.channels.fetch(hitsChannelId).catch(() => null);
    if (!hitsChannel || !hitsChannel.isTextBased()) {
      await dm.send("⚠️ I couldn’t find the hits channel. Ask an admin to check `hitsChannelId`.");
      return true;
    }

    const post = await hitsChannel.send({ embeds: [embed] });

    const db = readJson(DB_PATH, { hits: [] });
    db.hits.push({
      id: post.id,
      channelId: post.channel.id,
      messageId: post.id,
      userId: message.author.id,
      title,
      imageUrl: attach.url,
      createdAt: Date.now()
    });
    writeJson(DB_PATH, db);

    await dm.send(`✅ Posted! ${post.url}`);
    await message.reply("✅ Hit posted.");
    return true;
  }

  return { handleMessage };
}

module.exports = { createHitsFeature };
