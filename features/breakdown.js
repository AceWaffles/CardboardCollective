// features/breakdown.js
// Breakdown feature: parse → wizard → calculate → reply → prune

const SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes
const breakdownSessions = new Map();

function createBreakdownFeature({ config }) {
  // ---------- helpers: delete/prune ----------
  async function safeDeleteMessage(msg) {
    try {
      await msg.delete();
      return true;
    } catch (err) {
      console.log("⚠️ Delete failed:", err?.code || err?.message || err);
      return false;
    }
  }

  async function pruneWizardTrail(channel, messageIds, keepId = null) {
    for (const id of messageIds) {
      if (!id) continue;
      if (keepId && id === keepId) continue;
      try {
        const msg = await channel.messages.fetch(id);
        await safeDeleteMessage(msg);
      } catch {
        // already deleted / not fetchable
      }
    }
  }

  async function dmOrFallback(message, content) {
      try {
        await message.author.send(content);
        return { ok: true };
      } catch (err) {
        // DMs closed
        const warn = await message.reply(
          "🧠🥞 I tried to DM you but your DMs are closed. Here it is:\n\n" + content
        );
        // optional cleanup
        setTimeout(() => warn.delete().catch(() => {}), 30000);
        return { ok: false };
      }
    }

  // ---------- parsing + wizard ----------
function sniffBreak(input) {
  const original = input.trim();
  const lower = original.toLowerCase();

  const normalized = lower
    .replace(/[$,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const pickNum = (re) => {
    const m = normalized.match(re);
    return m ? Number(m[1]) : null;
  };

  // 1) labeled spots/boxes
  let spots = pickNum(/\b(\d+)\s*spots?\b/);
  let boxes = pickNum(/\b(\d+)\s*boxes?\b/);

  // 2) labeled price
  let price =
    pickNum(/\b(?:at|@)\s*(\d+(?:\.\d{1,2})?)\b/) ||
    pickNum(/\b(\d+(?:\.\d{1,2})?)\s*(?:each|ea)\b/);

  // 3) "98.98 a box" or "98.98 per box"
  if (price == null) {
    const m = normalized.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:a|per)\s*box(?:es)?\b/);
    if (m) price = Number(m[1]);
  }

  // 4) "3 x 98.98" or "3*98.98"
  if (boxes == null || price == null) {
    const m = normalized.match(/\b(\d+)\s*[x*]\s*(\d+(?:\.\d{1,2})?)\b/);
    if (m) {
      boxes ??= Number(m[1]);
      price ??= Number(m[2]);
    }
  }

  // ✅ 5) THE IMPORTANT NEW RULE:
  // If we have labeled spots AND labeled boxes, but price is missing,
  // treat the LAST decimal-ish number as price (excluding the boxes/spots themselves).
  if (spots != null && boxes != null && price == null) {
    const nums = normalized.match(/\b\d+(?:\.\d{1,2})?\b/g)?.map(Number) || [];
    // Remove exact integer matches for spots/boxes from candidate list
    const candidates = nums.filter(n => n !== spots && n !== boxes);
    // Prefer a decimal number if present (like 98.98), else last candidate
    const decimal = candidates.find(n => !Number.isInteger(n));
    price = decimal ?? (candidates.length ? candidates[candidates.length - 1] : null);
  }

  // 6) If boxes missing but phrase "a box"
  if (boxes == null && /\ba\s+box\b/.test(normalized)) boxes = 1;

  const data = {
    spots: Number.isFinite(spots) ? spots : null,
    boxes: Number.isFinite(boxes) ? boxes : null,
    costPerBox: Number.isFinite(price) ? price : null
  };

  const missing = [];
  if (!data.spots || data.spots <= 0) missing.push("spots");
  if (!data.boxes || data.boxes <= 0) missing.push("boxes");
  if (!data.costPerBox || data.costPerBox <= 0) missing.push("cost per box");

  return { data, missing, normalized };
}


  function promptForStep(step) {
    if (step === "spots") return "🧠🥞 How many **spots**? (reply with just a number)";
    if (step === "boxes") return "🧠🥞 How many **boxes**? (reply with just a number)";
    if (step === "costPerBox") return "🧠🥞 What’s the **cost per box**? (reply with just a number)";
    return "🧠🥞 Got it.";
  }

  function startBreakdownWizard(partialData) {
    const data = {
      spots: partialData.spots ?? null,
      boxes: partialData.boxes ?? null,
      costPerBox: partialData.costPerBox ?? null
    };

    const needed = [];
    if (!data.spots) needed.push("spots");
    if (!data.boxes) needed.push("boxes");
    if (!data.costPerBox) needed.push("costPerBox");

    const step = needed[0] || "done";

    return {
      step,
      needed,
      data,
      startedAt: Date.now(),
      prompt: promptForStep(step),
      messageIds: []
    };
  }

  function advanceBreakdownWizard(session, userText) {
    const txt = userText.toLowerCase().replace(/[$,]/g, " ").replace(/\s+/g, " ").trim();
    const num = txt.match(/\b\d+(?:\.\d{1,2})?\b/);
    const value = num ? Number(num[0]) : null;

    // If they paste a full command mid-wizard, re-parse and finish if possible
    const parsed = sniffBreak(userText);
    if (parsed.missing.length === 0) {
      return { ...session, step: "done", data: parsed.data, startedAt: Date.now() };
    }

    if (value && value > 0) {
      if (session.step === "spots") session.data.spots = Math.trunc(value);
      if (session.step === "boxes") session.data.boxes = Math.trunc(value);
      if (session.step === "costPerBox") session.data.costPerBox = value;
    }

    const needed = [];
    if (!session.data.spots) needed.push("spots");
    if (!session.data.boxes) needed.push("boxes");
    if (!session.data.costPerBox) needed.push("costPerBox");

    if (needed.length === 0) {
      return { ...session, step: "done", data: session.data, startedAt: Date.now() };
    }

    const nextStep = needed[0];

    return {
      ...session,
      startedAt: Date.now(),
      step: nextStep,
      needed,
      prompt: value
        ? promptForStep(nextStep)
        : "🧠🥞 I didn’t catch a number—reply with just the number (or type `mw cancel`)."
    };
  }

  // ---------- math + formatting ----------
  function calculateBreakdown(input) {
    const feeRate = config.defaults.platform.feeRate;
    const txFee = config.defaults.platform.txFee;

    const shipPerSpot = config.defaults.shipping.perSpot ?? 0;
    const suppliesPerSpot = config.defaults.supplies.perSpot ?? 0;

    const spots = Number(input.spots);
    const boxes = Number(input.boxes);
    const costPerBox = Number(input.costPerBox ?? input.costEach);

    const productCost = boxes * costPerBox;
    const txFees = spots * txFee;

    const supplies = spots * suppliesPerSpot;
    const shipping = spots * shipPerSpot;

    const coreNumerator = productCost + txFees + supplies;
    const breakevenRevenueNoShip = coreNumerator / (1 - feeRate);
    const breakevenPerSpotNoShip = breakevenRevenueNoShip / spots;

    const shipNumerator = coreNumerator + shipping;
    const breakevenRevenueWithShip = shipNumerator / (1 - feeRate);
    const breakevenPerSpotWithShip = breakevenRevenueWithShip / spots;

    return {
      input: { spots, boxes, costPerBox },
      productCost,
      txFees,
      supplies,
      shipping,
      feeRate,
      txFee,
      breakevenRevenueNoShip,
      breakevenPerSpotNoShip,
      breakevenRevenueWithShip,
      breakevenPerSpotWithShip
    };
  }

  function money(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "—";
    return `$${num.toFixed(2)}`;
  }

  function formatBreakdown(r) {
    return (
      `**🧠🥞 Mecha Waffles Breakdown**\n` +
      `Spots: **${r.input.spots}** | Boxes: **${r.input.boxes}** @ **${money(r.input.costPerBox)}**\n\n` +
      `**Costs**\n` +
      `• Product: ${money(r.productCost)}\n` +
      `• Tx fees: ${money(r.txFees)} (${money(r.txFee)} / spot)\n` +
      `• Supplies: ${money(r.supplies)}\n` +
      `• Shipping (Whatnot-handled): ${money(r.shipping)}\n\n` +
      `**Break-even (No Shipping — Whatnot Standard)**\n` +
      `• Revenue needed: **${money(r.breakevenRevenueNoShip)}** (${money(r.breakevenPerSpotNoShip)}/spot)\n\n` +
      `**Break-even (With Shipping — Informational Only)**\n` +
      `• Revenue needed: ${money(r.breakevenRevenueWithShip)} (${money(r.breakevenPerSpotWithShip)}/spot)\n\n` +
      `_Shipping is shown for reference only. Whatnot collects shipping separately._`
    );
  }

  // ---------- public API: handle messages ----------
  async function handleMessage(message) {
    if (message.author.bot) return false;

    const text = message.content.trim();
    const lower = text.toLowerCase();
    const sessionKey = `${message.author.id}`;

    // If in wizard, accept any non-command reply
    const existing = breakdownSessions.get(sessionKey);
    if (existing) {
      const expired = Date.now() - existing.startedAt >= SESSION_TTL_MS;
      if (expired) {
        breakdownSessions.delete(sessionKey);
      } else {
        const isNewCommand = lower.startsWith("mw") || lower.startsWith("mecha");

        // cancel
        if (lower === "cancel" || lower === "mw cancel" || lower === "mecha cancel") {
          breakdownSessions.delete(sessionKey);
          existing.messageIds.push(message.id);

          const done = await message.reply("🧠🥞 Cancelled.");
          await pruneWizardTrail(message.channel, existing.messageIds, done.id);
          return true;
        }

        if (!isNewCommand) {
          existing.messageIds.push(message.id);

          const next = advanceBreakdownWizard(existing, text);

          if (next.step === "done") {
            breakdownSessions.delete(sessionKey);

            const result = calculateBreakdown(next.data);

            const out = formatBreakdown(result);
            await dmOrFallback(message, out);
            return true;

          }

          const dm = await message.author.createDM();
          const promptMsg = await dm.send(next.prompt);
          next.messageIds.push(promptMsg.id);
          breakdownSessions.set(sessionKey, next);
          return true;
        }

        // new command cancels wizard quietly
        breakdownSessions.delete(sessionKey);
      }
    }

    // Only react to mw/mecha commands
    const isMechaCmd = lower.startsWith("mecha");
    const isMwCmd = lower.startsWith("mw");
    if (!isMechaCmd && !isMwCmd) return false;

    const body = lower.replace(/^mecha\b\s*/i, "").replace(/^mw\b\s*/i, "");
    const rawBody = text.replace(/^mecha\b\s*/i, "").replace(/^mw\b\s*/i, "");

    if (body === "cancel") {
      return message.reply("🧠🥞 Nothing to cancel right now.").then(() => true);
    }

    // breakdown trigger
    if (body.includes("breakdown")) {
      const parsed = sniffBreak(rawBody);

      // immediate answer
      if (parsed.missing.length === 0) {
        const result = calculateBreakdown(parsed.data);
        const out = formatBreakdown(result);

        // delete the user's command message (best effort)
        await message.delete().catch(() => {});

        // DM the output (fallback if DMs closed)
        await dmOrFallback(message, out);

        return true;

      }

      // wizard
      const wizard = startBreakdownWizard(parsed.data);
      wizard.messageIds.push(message.id);

      breakdownSessions.set(sessionKey, wizard);

      // delete the command to avoid clutter
      await message.delete().catch(() => {});

      // DM the first question
      const dm = await message.author.createDM();
      const promptMsg = await dm.send(wizard.prompt);

      // Track message ids ONLY for DMs now (optional)
      wizard.messageIds.push(promptMsg.id);

      // Track origin so we can delete it / reference it later (optional)
      wizard.origin = { guildId: message.guild?.id ?? null, channelId: message.channel.id };

      breakdownSessions.set(sessionKey, wizard);
      return true;
    }

    return false;
  }

  return { handleMessage };
}

module.exports = { createBreakdownFeature };
