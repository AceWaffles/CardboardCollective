// features/listings.js
const path = require("path");
const { EmbedBuilder } = require("discord.js");
const { readJson, writeJson } = require("../utils/jsonStore");

const DB_PATH = path.join(__dirname, "..", "data", "listings.json");

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

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

async function collectPhotos(dm) {
  await dm.send("📸 Send **1–2 photos** of the card (attach images). Type `skip` to cancel.");

  const photos = [];
  const endAt = Date.now() + 2 * 60 * 1000;

  while (photos.length < 2 && Date.now() < endAt) {
    const collected = await dm.awaitMessages({
      max: 1,
      time: endAt - Date.now(),
      errors: ["time"]
    });

    const msg = collected.first();
    const content = normalize(msg.content).toLowerCase();

    if (content === "skip" || content === "cancel") {
      return { cancelled: true, photos: [] };
    }

    const attachments = [...msg.attachments.values()];
    const images = attachments.filter(a =>
      a.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(a.url)
    );

    for (const img of images) {
      photos.push(img.url);
      if (photos.length >= 2) break;
    }

    if (photos.length === 0) {
      await dm.send("⚠️ I didn’t detect an image attachment. Please attach a photo (or type `cancel`).");
    } else if (photos.length < 2) {
      await dm.send("✅ Got it. You can send **one more** photo, or type `done`.");
      // allow done
      const maybeDone = await dm.awaitMessages({ max: 1, time: 60 * 1000 }).catch(() => null);
      const doneMsg = maybeDone?.first();
      if (doneMsg && normalize(doneMsg.content).toLowerCase() === "done") break;
    }
  }

  return { cancelled: false, photos };
}

function getUserLimit(member, config) {
  const proRoleName = config?.listings?.proRoleName || "Collective Pro";
  const standardLimit = config?.listings?.standardLimit ?? 3;
  const proLimit = config?.listings?.proLimit ?? 10;

  const isPro = member?.roles?.cache?.some(r => r.name === proRoleName);
  return isPro ? proLimit : standardLimit;
}

function getActiveCount(db, userId) {
  return db.listings.filter(l =>
    l.sellerId === userId && (l.status === "OPEN" || l.status === "CLAIMED")
  ).length;
}

function saveListing(db, listing) {
  db.listings.push(listing);
  writeJson(DB_PATH, db);
}

function createListingsFeature({ config, client }) {
  async function handleMessage(message) {
    const lower = message.content.trim().toLowerCase();
    const isTrigger =
      lower === "mw sell" ||
      lower === "mw trade" ||
      lower === "mw list";

    if (!isTrigger) return false;

    // must be in guild to check roles/limits
    if (!message.guild) {
      await message.reply("Use `mw sell` in the server so I can verify your listing limits.");
      return true;
    }

    const listingsCfg = config?.listings || {};
    const tradeChannelId = listingsCfg.tradeChannelId;
    if (!tradeChannelId) {
      await message.reply("⚠️ Listings are not configured yet (missing `listings.tradeChannelId` in config.json).");
      return true;
    }

    const db = readJson(DB_PATH, { listings: [] });

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    const limit = getUserLimit(member, config);
    const active = getActiveCount(db, message.author.id);

    if (active >= limit) {
      await message.reply(`🚫 You already have **${active} active listings**. Your limit is **${limit}**. Close or mark one sold to post a new one.`);
      return true;
    }

    // Start DM wizard
    let dm;
    try {
      dm = await message.author.createDM();
      await dm.send("🧠🥞 **Cardboard Collective Listing Wizard**\nReply to each question. Type `cancel` anytime to stop.");
    } catch {
      await message.reply("⚠️ I couldn’t DM you. Please enable DMs from server members and try again.");
      return true;
    }

    // Q1: listing type
    const qType = await ask(dm, "1) Listing type: reply with `FS`, `FT`, or `FS/FT`");
    const type = normalize(qType.content).toUpperCase();
    if (!["FS", "FT", "FS/FT"].includes(type) || type === "CANCEL") {
      await dm.send("Cancelled or invalid type. Start again with `mw sell`.");
      return true;
    }

    // Q2: title
    const qTitle = await ask(dm, "2) What are you listing? (short title)\nExample: `2024 Topps Chrome Marvel – Wolverine /99`");
    const title = normalize(qTitle.content);
    if (!title || title.toLowerCase() === "cancel") {
      await dm.send("Cancelled.");
      return true;
    }

    // Q3: description
    const qDesc = await ask(dm, "3) Small description (1–2 sentences)");
    const description = normalize(qDesc.content);
    if (!description || description.toLowerCase() === "cancel") {
      await dm.send("Cancelled.");
      return true;
    }

    // Optional block: shipping/payment/location
    const qShipIncluded = await ask(dm, "4) Shipping included? Reply `yes` or `no`");
    const shippingIncluded = normalize(qShipIncluded.content).toLowerCase() === "yes";

    const qShipMethod = await ask(dm, "5) Shipping method: `PWE`, `BMWT`, or `Either`");
    const shippingMethod = normalize(qShipMethod.content).toUpperCase();

    const qPayment = await ask(dm, "6) Payment methods (comma-separated)\nExample: `PayPal G&S, Venmo`");
    const payment = normalize(qPayment.content);

    const qLocation = await ask(dm, "7) Location/Region (optional) or type `skip`");
    const location = normalize(qLocation.content);
    const locationFinal = location.toLowerCase() === "skip" ? "" : location;

    // Sale/trade specifics
    let price = "";
    let obo = false;
    let tradeWants = "";

    if (type === "FS" || type === "FS/FT") {
      const qPrice = await ask(dm, "8) Price (numbers only or include $). Example: `$85`");
      price = normalize(qPrice.content);
      if (price.toLowerCase() === "cancel") return true;

      const qOBO = await ask(dm, "9) OBO? Reply `yes` or `no`");
      obo = normalize(qOBO.content).toLowerCase() === "yes";
    }

    if (type === "FT" || type === "FS/FT") {
      const qWants = await ask(dm, "10) Trade wants (what are you looking for?)");
      tradeWants = normalize(qWants.content);
      if (tradeWants.toLowerCase() === "cancel") return true;
    }

    // Photos
    const photoResult = await collectPhotos(dm);
    if (photoResult.cancelled || photoResult.photos.length === 0) {
      await dm.send("Cancelled (photos are required).");
      return true;
    }

    // Build standardized embed
    const tags = [];
    if (type === "FS") tags.push("FS");
    if (type === "FT") tags.push("FT");
    if (type === "FS/FT") tags.push("FS/FT");
    tags.push("OPEN");
    if (obo) tags.push("OBO");

    const embed = new EmbedBuilder()
      .setTitle(`[${type}] ${title}`)
      .setDescription(description)
      .addFields(
        ...(price ? [{ name: "Price", value: `${price}${obo ? " (OBO)" : ""}`, inline: true }] : []),
        ...(tradeWants ? [{ name: "Trade Wants", value: tradeWants, inline: false }] : []),
        { name: "Shipping", value: `${shippingIncluded ? "Included" : "Not included"} • ${shippingMethod}`, inline: true },
        { name: "Payment", value: payment || "Not specified", inline: true },
        ...(locationFinal ? [{ name: "Location", value: locationFinal, inline: true }] : []),
        { name: "Seller", value: `<@${message.author.id}>`, inline: true },
        { name: "Status", value: tags.map(t => `\`${t}\``).join(" "), inline: false }
      )
      .setFooter({ text: "Cardboard Collective • Reply in thread to claim or ask questions • Use /sold when complete" })
      .setTimestamp(new Date());

    // Attach first photo as embed image (clean look)
    embed.setImage(photoResult.photos[0]);

    // Post to trade channel
    const tradeChannel = await client.channels.fetch(tradeChannelId).catch(() => null);
    if (!tradeChannel || !tradeChannel.isTextBased()) {
      await dm.send("⚠️ I couldn’t find the trade channel. Ask an admin to check `tradeChannelId`.");
      return true;
    }

    const post = await tradeChannel.send({
      content: `🧾 **New Listing** from <@${message.author.id}>`,
      embeds: [embed],
      files: photoResult.photos.slice(1).map(url => ({ attachment: url }))
    });

    // Save to DB
    const listing = {
      id: post.id,
      channelId: post.channel.id,
      messageId: post.id,
      sellerId: message.author.id,
      type,
      title,
      description,
      price,
      obo,
      tradeWants,
      shippingIncluded,
      shippingMethod,
      payment,
      location: locationFinal,
      photos: photoResult.photos,
      status: "OPEN",
      createdAt: Date.now(),
      createdTs: nowTs()
    };

    saveListing(db, listing);

    await dm.send(`✅ Posted! Your listing is live here: ${post.url}`);
    await message.reply("✅ Check your DMs — your listing wizard is complete.");

    return true;
  }

  return { handleMessage };
}

module.exports = { createListingsFeature };
