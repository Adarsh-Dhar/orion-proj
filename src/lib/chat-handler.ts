/**
 * chat-handler.ts — grammy message handler for Telegram bot.
 *
 * Handles incoming messages, extracts token addresses, runs rug checks,
 * and sends formatted reports back to the chat.
 *
 * Exports:
 *   registerChatHandler(bot, client, state) — registers the message:text handler
 */

import { Bot, Context, InlineKeyboard } from "grammy";
import { extractAddress, answerTokenQuestion, stripAddress } from "./rugcheck-handler.js";
import { formatChatReply, formatRugReport } from "./rugcheck.js";
import { sendReport, sendPlain } from "./telegram.js";
import type { PublicClient } from "viem";
import type { BotState } from "./state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

// ─── Shared helper: send full report (used by /full command and button callback) ───
async function sendFullReport(
  ctx: Context,
  client: AnyClient,
  address: string,
  state?: BotState
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.api.sendMessage(chatId, "Running full on-chain rug check…");

  // Progress callback to send updates to user
  const onProgress = (step: string, message: string) => {
    // Only send progress updates for main steps, not every sub-step
    if (["validating", "pool", "metadata", "deploy", "llm"].includes(step)) {
      ctx.api.sendMessage(chatId, `🔍 ${message}`).catch((err: unknown) => {
        console.warn(`[chat-handler] Failed to send progress update:`, err);
      });
    }
  };

  const TIMEOUT_MS = 3 * 60_000; // Reduced to 3 minutes due to sniper mode efficiency
  let outcome: Awaited<ReturnType<typeof answerTokenQuestion>>;
  try {
    outcome = await Promise.race([
      answerTokenQuestion(client, address as `0x${string}`, undefined, "chat", state, onProgress, false, true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out after 3 minutes")), TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[chat-handler] Analysis failed for ${address}:`, err);

    // Provide more helpful error message
    let userMessage = `Couldn't check that token: ${errorMessage}`;
    if (errorMessage.includes("timed out")) {
      userMessage = `⏱️ Analysis timed out after 3 minutes. This is likely due to RPC rate limiting. Try again in a few minutes or check your RPC endpoint configuration.`;
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

export function registerChatHandler(bot: Bot<any>, client: AnyClient, state?: BotState): void {
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
      await sendFullReport(ctx, client, address, state);
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

    // Use sniper mode for all manual queries (efficient like the sniper)
    const isSniperMode = true;

    await ctx.api.sendMessage(chatId, "Running on-chain rug check…");
    console.log(`[chat-handler] Starting analysis for ${address}`);

    // Progress callback to send updates to user
    const onProgress = (step: string, message: string) => {
      // Only send progress updates for main steps, not every sub-step
      if (["validating", "pool", "metadata", "deploy", "llm"].includes(step)) {
        ctx.api.sendMessage(chatId, `🔍 ${message}`).catch((err: unknown) => {
          console.warn(`[chat-handler] Failed to send progress update:`, err);
        });
      }
    };

    // Wrap the full pipeline in a 3-minute timeout so the user always gets
    // a reply — without this, a hung RPC call silently swallows the response.
    const TIMEOUT_MS = 3 * 60_000;
    let outcome: Awaited<ReturnType<typeof answerTokenQuestion>>;
    try {
      outcome = await Promise.race([
        answerTokenQuestion(
          client,
          address,
          question.length > 0 ? question : undefined,
          "chat",
          state,
          onProgress,
          isQuickMode,
          isSniperMode
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Analysis timed out after 3 minutes")), TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[chat-handler] Analysis failed for ${address}:`, err);

      // Provide more helpful error message
      let userMessage = `Couldn't check that token: ${errorMessage}`;
      if (errorMessage.includes("timed out")) {
        userMessage = `⏱️ Analysis timed out after 3 minutes. This is likely due to RPC rate limiting. Try again in a few minutes or check your RPC endpoint configuration.`;
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
      await sendFullReport(ctx, client, address as `0x${string}`, state);
    }
  });
}
