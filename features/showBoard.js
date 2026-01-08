// features/showBoard.js
// Wizard to create/update a user's show post in a Forum channel.
// Cleans up all interaction messages and DMs a receipt.

const SHOW_SESSION_TTL_MS = 4 * 60 * 1000; // 4 minutes
const showSessions = new Map(); // key: guild:channel:user => session

function createShowBoardFeature({ config }) {
  const forumChannelId = config?.showBoard?.forumChannelId;

  // -----------------------
  // Helpers: delete / prune
  // -----------------------
  async function safeDeleteMessage(msg) {
    try {
      await msg.delete();
      return true;
    } catch (err) {
      console.log("⚠️ Delete failed:", err?.code || err?.message || err);
      return false;
    }
  }

  async function pruneTrail(channel, messageIds) {
    for (const id of messageIds) {
      if (!id) continue;
      try {
        const msg = await channel.messages.fetch(id);
        await safeDeleteMessage(msg);
      } catch {
        // already deleted / not fetchable
      }
    }
  }

  // -----------------------
  // Storage (simple JSON)
  // -----------------------
  const fs = require("fs");
  const path = require("path");
  const DATA_DIR = path.join(process.cwd(), "data");
  const SHOWS_FILE = path.join(DATA_DIR, "shows.json");

  function ensureDataFiles() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    if (!fs.existsSync(SHOWS_FILE)) fs.writeFileSync(SHOWS_FILE, "{}", "utf8");
  }

  function loadShows() {
    ensureDataFiles();
    try {
      return JSON.parse(fs.readFileSync(SHOWS_FILE, "utf8"));
    } catch {
      return {};
    }
  }

  function saveShows(obj) {
    ensureDataFiles();
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(obj, null, 2), "utf8");
  }

  function getGuildShows(store, guildId) {
    store[guildId] ??= [];
    return store[guildId];
  }

  function findUserShow(guildShows, ownerId) {
    return guildShows.find((s) => s.ownerId === ownerId);
  }

  // -----------------------
  // Wizard questions
  // -----------------------
  const STEPS = ["whatnotName", "date", "time", "description", "link"];

  function promptFor(step) {
    switch (step) {
      case "whatnotName":
        return "🧠🥞 What is your **Whatnot username**?";
      case "date":
        return "🧠🥞 What is the **date** of the show? (example: `Jan 9` or `2026-01-09`)";
      case "time":
        return "🧠🥞 What is the **time**? (example: `7:00pm ET` or `8pm`)";
      case "description":
        return "🧠🥞 Drop a short **description** (what’s breaking / format / anything important).";
      case "link":
        return "🧠🥞 Optional: paste the **Whatnot link** (or reply `skip`).";
      default:
        return "🧠🥞 Got it.";
    }
  }

  function startSession(message) {
    return {
      stepIndex: 0,
      data: {
        whatnotName: null,
        date: null,
        time: null,
        description: null,
        link: null
      },
      startedAt: Date.now(),
      messageIds: [message.id] // include the command msg for cleanup
    };
  }

  function currentStep(session) {
    return STEPS[session.stepIndex] ?? "done";
  }

  function applyAnswer(session, step, rawText) {
    const t = rawText.trim();

    if (step === "link") {
      if (t.toLowerCase() === "skip" || t.toLowerCase() === "none") {
        session.data.link = null;
      } else {
        session.data.link = t;
      }
      return;
    }

    // basic text fields
    session.data[step] = t;
  }

  function isComplete(data) {
    return !!data.whatnotName && !!data.date && !!data.time && !!data.description;
  }

  // -----------------------
  // Forum post create/update
  // -----------------------
  function buildTitle(data) {
    // Title: "WhatnotName : Date Time"
    return `${data.whatnotName} : ${data.date} ${data.time}`;
  }

  function buildBody(data) {
    // Body: Description then link on its own line (so preview card shows)
    const parts = [];
    parts.push(data.description);

    if (data.link) {
      parts.push(""); // blank line
      parts.push(data.link);
    }

    return parts.join("\n");
  }

  async function createForumPost(forumChannel, data) {
    const name = buildTitle(data);
    const content = buildBody(data);

    // Create a forum thread/post
    const thread = await forumChannel.threads.create({
      name,
      message: { content }
      // appliedTags: [] // optional later
    });

    // Starter message is the first message inside the thread
    const firstMessage = await thread.fetchStarterMessage();

    return {
      threadId: thread.id,
      firstMessageId: firstMessage?.id ?? null
    };
  }

  async function updateForumPost(thread, firstMessageId, data) {
    const newTitle = buildTitle(data);
    const newBody = buildBody(data);

    // Update thread title
    await thread.setName(newTitle);

    // Update starter message body
    if (firstMessageId) {
      const starter = await thread.messages.fetch(firstMessageId);
      await starter.edit(newBody);
    } else {
      // fallback: try starter fetch
      const starter = await thread.fetchStarterMessage();
      if (starter) await starter.edit(newBody);
    }
  }

  // -----------------------
  // DM receipt
  // -----------------------
  function receiptText({ action, data, threadUrl }) {
    return (
      `**🧠🥞 Mecha Waffles — Show Card ${action}**\n` +
      `**Whatnot:** ${data.whatnotName}\n` +
      `**When:** ${data.date} ${data.time}\n` +
      `**Description:** ${data.description}\n` +
      `**Link:** ${data.link ?? "(none)"}\n` +
      (threadUrl ? `\n**Forum Post:** ${threadUrl}\n` : "") +
      `\nIf you need to change anything, just run \`mw show\` again.`
    );
  }

  // -----------------------
  // Public handler
  // -----------------------
  async function handleMessage(message) {
    if (message.author.bot) return false;
    if (!message.guild) return false; // keep it server-based for now

    const text = message.content.trim();
    const lower = text.toLowerCase();

    const sessionKey = `${message.guild.id}:${message.channel.id}:${message.author.id}`;

    // If a session exists and not expired, accept non-command replies
    const existing = showSessions.get(sessionKey);
    if (existing) {
      const expired = Date.now() - existing.startedAt >= SHOW_SESSION_TTL_MS;
      if (expired) {
        showSessions.delete(sessionKey);
      } else {
        const isNewCommand = lower.startsWith("mw") || lower.startsWith("mecha");

        // Cancel
        if (lower === "cancel" || lower === "mw cancel" || lower === "mecha cancel") {
          showSessions.delete(sessionKey);
          existing.messageIds.push(message.id);

          // Clean up everything (no need to leave a message; user asked for pruning)
          await pruneTrail(message.channel, existing.messageIds);

          // DM cancel notice (best effort)
          try {
            await message.author.send("🧠🥞 Show wizard cancelled.");
          } catch {}

          return true;
        }

        if (!isNewCommand) {
          // track user answer message for cleanup
          existing.messageIds.push(message.id);

          const step = currentStep(existing);
          applyAnswer(existing, step, text);

          existing.stepIndex += 1;
          existing.startedAt = Date.now(); // extend TTL as they answer

          if (!isComplete(existing.data)) {
            const nextStep = currentStep(existing);
            const prompt = promptFor(nextStep);

            const promptMsg = await message.reply(prompt);
            existing.messageIds.push(promptMsg.id);
            showSessions.set(sessionKey, existing);
            return true;
          }

          // We have all required data (link is optional; might still be at link step)
          // If they reached completion before link step, we still allow link to be asked once:
          if (existing.data.link === null && step !== "link" && currentStep(existing) === "link") {
            const promptMsg = await message.reply(promptFor("link"));
            existing.messageIds.push(promptMsg.id);
            showSessions.set(sessionKey, existing);
            return true;
          }

          // DONE: create/update post
          showSessions.delete(sessionKey);

          // Must have forum channel configured
          if (!forumChannelId) {
            // prune interaction, DM error
            await pruneTrail(message.channel, existing.messageIds);
            try {
              await message.author.send(
                "🧠🥞 I can’t post your show yet: `config.showBoard.forumChannelId` is not set."
              );
            } catch {}
            return true;
          }

          const forumChannel = await message.guild.channels.fetch(forumChannelId);
          if (!forumChannel || forumChannel.type !== 15 /* GuildForum */) {
            await pruneTrail(message.channel, existing.messageIds);
            try {
              await message.author.send("🧠🥞 Forum channel ID is invalid or not a Forum channel.");
            } catch {}
            return true;
          }

          // Load store and locate existing show for this user
          const store = loadShows();
          const guildShows = getGuildShows(store, message.guild.id);
          let record = findUserShow(guildShows, message.author.id);

          let action = "Created";
          let threadUrl = null;

          try {
            if (!record) {
              const created = await createForumPost(forumChannel, existing.data);

              record = {
                ownerId: message.author.id,
                threadId: created.threadId,
                firstMessageId: created.firstMessageId,
                ...existing.data,
                updatedUtc: new Date().toISOString()
              };

              guildShows.push(record);
              saveShows(store);

              // Build thread URL
              threadUrl = `https://discord.com/channels/${message.guild.id}/${created.threadId}`;
            } else {
              action = "Updated";

              // Fetch thread and update
              const thread = await forumChannel.threads.fetch(record.threadId);
              if (!thread) throw new Error("Thread not found (may have been deleted).");

              await updateForumPost(thread, record.firstMessageId, existing.data);

              // Update stored data
              Object.assign(record, existing.data, { updatedUtc: new Date().toISOString() });
              saveShows(store);

              threadUrl = `https://discord.com/channels/${message.guild.id}/${record.threadId}`;
            }

            // DM receipt (best effort)
            try {
              await message.author.send(receiptText({ action, data: existing.data, threadUrl }));
            } catch (dmErr) {
              // If DMs are closed, we’ll have to notify in-channel (but user asked prune)
              // Best compromise: post a short message THEN delete it after a moment (if possible).
              const warn = await message.reply(
                "🧠🥞 I posted/updated your show, but I couldn’t DM you (DMs closed)."
              );
              // attempt delete after 5s
              setTimeout(() => safeDeleteMessage(warn), 5000);
            }

            // prune all interaction messages (command + Q/A + prompts)
            await pruneTrail(message.channel, existing.messageIds);
            return true;
          } catch (err) {
            console.log("❌ Show post failed:", err);

            // prune interaction
            await pruneTrail(message.channel, existing.messageIds);

            // DM error
            try {
              await message.author.send(
                `🧠🥞 I couldn't create/update your show card. Error: ${err?.message ?? err}`
              );
            } catch {}
            return true;
          }
        }

        // New command while mid-session => cancel session silently
        showSessions.delete(sessionKey);
      }
    }

    // Only start wizard on mw/mecha commands
    const isMechaCmd = lower.startsWith("mecha");
    const isMwCmd = lower.startsWith("mw");
    if (!isMechaCmd && !isMwCmd) return false;

    const body = lower.replace(/^mecha\b\s*/i, "").replace(/^mw\b\s*/i, "");

    // Start wizard commands:
    // "mw show" or "mw show add" or "mw show update"
    if (body === "show" || body.startsWith("show ")) {
      const session = startSession(message);
      showSessions.set(sessionKey, session);

      const promptMsg = await message.reply(promptFor("whatnotName"));
      session.messageIds.push(promptMsg.id);
      showSessions.set(sessionKey, session);

      return true;
    }

    return false;
  }

  return { handleMessage };
}

module.exports = { createShowBoardFeature };
