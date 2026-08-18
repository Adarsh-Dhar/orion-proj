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
  const outcome = await answerTokenQuestion(client, address as `0x${string}`, undefined, "chat", state);
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
    await ctx.api.sendMessage(
      chatId,
      "📖 *How to use RugHound*\n\n" +
      "1. **Quick check**: Send any Base token address (0x...) to get a risk summary.\n" +
      "2. **Full report**: Use `/full 0x...` for the complete on-chain analysis.\n" +
      "3. **Ask questions**: Include your question with the address, e.g.,\n" +
      "   \"What are the liquidity risks for 0x...?\"\n\n" +
      "I check ownership, liquidity, honeypot status, source code, and more.",
      { parse_mode: "Markdown" }
    );
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.message || !ctx.message.text || !ctx.chat) return;

    const text = ctx.message.text;

    // /full <address> — full report on demand
    if (text.startsWith("/full")) {
      const address = extractAddress(text);
      if (!address) {
        const chatId = ctx.chat?.id;
        if (chatId) {
          await ctx.api.sendMessage(chatId, "Usage: /full 0x... — sends the complete on-chain report.");
        }
        return;
      }
      await sendFullReport(ctx, client, address, state);
      return;
    }

    const address = extractAddress(text);
    if (!address) {
      const chatId = ctx.chat?.id;
      const isGroup = ctx.chat?.type !== "private";
      if (isGroup && !text.includes(`@${ctx.me.username}`)) return;
      if (chatId) {
        await ctx.api.sendMessage(chatId, "Send a Base token address (0x...) — or ask me a specific question about one.");
      }
      return;
    }

    // Strip the address so the LLM gets the actual question, not the address itself
    const question = stripAddress(text, address);

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    await ctx.api.sendMessage(chatId, "Running on-chain rug check…");

    const outcome = await answerTokenQuestion(
      client,
      address,
      question.length > 0 ? question : undefined,
      "chat",
      state
    );

    if ("error" in outcome) {
      await ctx.api.sendMessage(chatId, `Couldn't check that token: ${outcome.error}`);
      return;
    }

    // Create inline keyboard with "Full Report" button
    const keyboard = new InlineKeyboard().text(
      "📋 Full Report",
      `full:${address}`
    );

    await sendPlain(chatId, formatChatReply(outcome.result, outcome.meta), keyboard);
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
