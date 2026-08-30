/**
 * chat-handler.ts — grammy message handler for Telegram bot.
 *
 * Handles incoming messages, extracts token addresses, runs rug checks,
 * and sends formatted reports back to the chat.
 *
 * Exports:
 *   registerChatHandler(bot, client) — registers the message:text handler
 */

import { Bot, Context, InlineKeyboard } from "grammy";
import { extractAddress, answerTokenQuestion, stripAddress } from "./rugcheck-handler.js";
import { formatChatReply, formatRugReport } from "./rugcheck.js";
import { sendReport, sendPlain } from "./telegram.js";
import { getLatestAnalysis } from "./analysis-store.js";
import type { PublicClient } from "viem";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

// ─── Shared helper: send full report (used by /full command and button callback) ───
async function sendFullReport(
  ctx: Context,
  client: AnyClient,
  address: string
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.api.sendMessage(chatId, "Running full on-chain rug check…");

  // Progress callback to send updates to user
  const onProgress = (step: string, message: string) => {
    if (["validating", "pool", "metadata", "deploy", "llm"].includes(step)) {
      ctx.api.sendMessage(chatId, `🔍 ${message}`).catch((err: unknown) => {
        console.warn(`[chat-handler] Failed to send progress update:`, err);
      });
    }
  };

  const TIMEOUT_MS = 15 * 60_000; // Increased to 15 minutes for agentic mode
  let outcome: Awaited<ReturnType<typeof answerTokenQuestion>>;
  try {
    outcome = await Promise.race([
      // isSniperMode=false so we do a real deploy-block binary search instead
      // of using the current block, which would be wrong for non-fresh tokens.
      answerTokenQuestion(client, address as `0x${string}`, undefined, "chat", onProgress, false, false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out after 15 minutes")), TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[chat-handler] Analysis failed for ${address}:`, err);

    let userMessage = `Couldn't check that token: ${errorMessage}`;
    if (errorMessage.includes("timed out")) {
      userMessage = `⏱️ Analysis timed out — the RPC may be under load or the analysis is taking longer than expected. Try again in a few minutes.`;
    }

    await ctx.api.sendMessage(chatId, userMessage);
    return;
  }

  if ("error" in outcome) {
    await ctx.api.sendMessage(chatId, `Couldn't check that token: ${outcome.error}`);
    return;
  }
  await sendReport(chatId, formatRugReport(outcome.result, outcome.meta));
}

export function registerChatHandler(bot: Bot<any>, client: AnyClient): void {
  // Register commands first (order matters - commands get priority)
  bot.command("start", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    console.log(`[chat-handler] /start command from ${chatId}`);
    await ctx.api.sendMessage(
      chatId,
      "🐕 *RugHound — Base Token Rug Checker*\n\n" +
      "Send me a Base token address (0x...) and I'll run a full on-chain security analysis.\n\n" +
      "Commands:\n" +
      "/start — Show this welcome message\n" +
      "/help — Show usage instructions\n" +
      "/full 0x... — Get the complete detailed report\n\n" +
      "You can also ask me specific questions about a token, like:\n" +
      "\"Is 0x... safe to buy?\" or \"What are the red flags for 0x...?\"",
      { parse_mode: "Markdown" }
    );
  });

  bot.command("help", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    console.log(`[chat-handler] /help command from ${chatId}`);
    await ctx.api.sendMessage(
      chatId,
      "📖 *How to use RugHound*\n\n" +
      "1. **Quick check**: Send any Base token address (0x...) to get a risk summary.\n" +
      "2. **Full report**: Use `/full 0x...` for the complete on-chain analysis.\n" +
      "3. **Quick mode**: Add \"quick\" or \"fast\" to skip expensive checks, e.g.,\n" +
      "   \"quick check 0x...\" for faster analysis.\n" +
      "4. **Ask questions**: Include your question with the address, e.g.,\n" +
      "   \"What are the liquidity risks for 0x...?\"\n\n" +
      "I check ownership, liquidity, honeypot status, source code, and more.",
      { parse_mode: "Markdown" }
    );
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.message || !ctx.message.text || !ctx.chat) return;

    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    
    console.log(`[chat-handler] Received message from ${chatId}: ${text}`);

    // /full <address> — full report on demand
    if (text.startsWith("/full")) {
      const address = extractAddress(text);
      if (!address) {
        await ctx.api.sendMessage(chatId, "Usage: /full 0x... — sends the complete on-chain report.");
        return;
      }
      await sendFullReport(ctx, client, address);
      return;
    }

    const address = extractAddress(text);
    if (!address) {
      const isGroup = ctx.chat?.type !== "private";
      if (isGroup && !text.includes(`@${ctx.me.username}`)) return;
      await ctx.api.sendMessage(chatId, "Send a Base token address (0x...) — or ask me a specific question about one.");
      return;
    }

    // Strip the address so the LLM gets the actual question, not the address itself
    const question = stripAddress(text, address);

    // Check if user wants quick mode (skip expensive checks)
    const isQuickMode = text.toLowerCase().includes("quick") || text.toLowerCase().includes("fast");

    // Never use sniper mode for manual chat queries — sniper mode sets the
    // deploy block to the current block, which is wrong for tokens that were
    // deployed earlier. Chat queries need the real deploy block so evidence
    // collection scans the right range. Quick mode is still available for
    // users who want to skip the expensive binary-search deploy block lookup.
    const isSniperMode = false;

    await ctx.api.sendMessage(chatId, "Running on-chain rug check…");
    console.log(`[chat-handler] Starting analysis for ${address}`);

    // Check if a recent analysis exists — avoids re-running the full pipeline
    // while the sniper is running a large concurrent batch.
    const CACHE_MAX_AGE_MS = 30 * 60_000; // 30 minutes
    try {
      const cached = await getLatestAnalysis(address.toLowerCase());
      if (cached && Date.now() - cached.timestamp < CACHE_MAX_AGE_MS) {
        const ageMin = Math.round((Date.now() - cached.timestamp) / 60_000);
        console.log(`[chat-handler] Cache hit for ${address} (${ageMin} min old)`);
        const keyboard = new InlineKeyboard().text("📋 Full Report", `full:${address}`);
        const VERDICT_EMOJI: Record<string, string> = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🟠", CRITICAL: "🔴", INSUFFICIENT: "⚪", UNKNOWN: "❓" };
        const v = VERDICT_EMOJI[cached.verdict] ?? "❓";
        const topFlags = cached.flags.slice(0, 3).map(f => `• ${f.label}: ${f.detail}`).join("\n");
        const cacheMsg = [
          `${v} ${cached.verdict}  ·  ${cached.score.toFixed(2)}/100  ·  ${cached.tokenName} ($${cached.tokenSymbol})`,
          cached.summary,
          topFlags,
          `\n_(Cached ${ageMin} min ago — use /full ${address} for a fresh analysis)_`,
        ].filter(Boolean).join("\n");
        await sendPlain(chatId, cacheMsg, keyboard);
        return;
      }
    } catch {
      // Cache lookup failure is non-fatal — fall through to full analysis
    }

    // Progress callback to send updates to user
    const onProgress = (step: string, message: string) => {
      // Only send progress updates for main steps, not every sub-step
      if (["validating", "pool", "metadata", "deploy", "llm"].includes(step)) {
        ctx.api.sendMessage(chatId, `🔍 ${message}`).catch((err: unknown) => {
          console.warn(`[chat-handler] Failed to send progress update:`, err);
        });
      }
    };

    // Wrap the full pipeline in a timeout so the user always gets
    // a reply — deploy block binary search can be slow under RPC load.
    const TIMEOUT_MS = 15 * 60_000; // Increased to 15 minutes for agentic mode
    let outcome: Awaited<ReturnType<typeof answerTokenQuestion>>;
    try {
      outcome = await Promise.race([
        answerTokenQuestion(
          client,
          address,
          question.length > 0 ? question : undefined,
          "chat",
          onProgress,
          isQuickMode,
          isSniperMode
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Analysis timed out after 15 minutes")), TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[chat-handler] Analysis failed for ${address}:`, err);

      let userMessage = `Couldn't check that token: ${errorMessage}`;
      if (errorMessage.includes("timed out")) {
        userMessage = `⏱️ Analysis timed out — the RPC may be under load or the analysis is taking longer than expected. Try again in a few minutes.`;
      }

      await ctx.api.sendMessage(chatId, userMessage);
      return;
    }

    if ("error" in outcome) {
      await ctx.api.sendMessage(chatId, `Couldn't check that token: ${outcome.error}`);
      return;
    }

    // Create inline keyboard with "Full Report" button
    const keyboard = new InlineKeyboard().text(
      "📋 Full Report",
      `full:${address}`
    );

    try {
      await sendPlain(chatId, formatChatReply(outcome.result, outcome.meta), keyboard);
      console.log(`[chat-handler] Successfully sent report for ${address}`);
    } catch (sendErr) {
      console.error(`[chat-handler] Failed to send report for ${address}:`, sendErr);
      await ctx.api.sendMessage(chatId, "⚠️ Analysis completed but failed to send the report. Please try again.");
    }
  });

  // Handle callback queries from inline keyboard buttons
  bot.on("callback_query:data", async (ctx) => {
    if (!ctx.callbackQuery || !ctx.callbackQuery.data) return;

    const data = ctx.callbackQuery.data;

    // Handle "full:0x..." callback
    if (data.startsWith("full:")) {
      const address = data.split(":")[1];
      if (!address) return;

      // Answer the callback query to remove the loading spinner
      await ctx.answerCallbackQuery();

      // Send the full report
      await sendFullReport(ctx, client, address as `0x${string}`);
    }
  });
}
