// index.js
console.log("✅ Starting Mecha Waffles... (index.js loaded)");

process.on("unhandledRejection", (err) => console.error("❌ Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("❌ Uncaught Exception:", err));

require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,   // ✅ ADD THIS
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]          // ✅ ADD THIS (required for DM channels)
});

const { createBreakdownFeature } = require("./features/breakdown");
const { createShowBoardFeature } = require("./features/showBoard");

// Load config
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));

const token = process.env.DISCORD_TOKEN;
console.log(
  "🔑 Token present:",
  !!token,
  token ? `(len=${token.length}, starts=${token.slice(0, 6)}...)` : ""
);


client.on("warn", (m) => console.log("⚠️ WARN:", m));
client.on("error", (e) => console.log("❌ CLIENT ERROR:", e));

client.once("ready", () => console.log(`🧠🥞 READY: logged in as ${client.user.tag}`));

// Register features
const showBoard = createShowBoardFeature({ config });
const breakdown = createBreakdownFeature({ config });

client.on("messageCreate", async (message) => {
  // ✅ Route to features in order (Show board first)
  const handledShow = await showBoard.handleMessage(message);
  if (handledShow) return;

  const handledBreakdown = await breakdown.handleMessage(message);
  if (handledBreakdown) return;

  // fallback help for mw/mecha commands
  const lower = message.content.trim().toLowerCase();
  if (lower.startsWith("mw") || lower.startsWith("mecha")) {
    await message.reply(
      "🧠🥞 Commands:\n" +
      "• `mw show` (create/update your show card)\n" +
      "• `mw breakdown 75 spots 3 boxes at 92 each`"
    );
  }
});

(async () => {
  try {
    console.log("🔌 Logging in...");
    await client.login(token);
  } catch (err) {
    console.log("❌ LOGIN FAILED:", err);
  }
})();
