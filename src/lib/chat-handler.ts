/**
 * chat-handler.ts — grammy message handler for Telegram bot.
 *
 * Handles incoming messages, extracts token addresses, runs rug checks,
 * and sends formatted reports back to the chat.
 *
 * Exports:
 *   registerChatHandler(bot, client) — registers the message:text handler
 */

import { Bot, Context } from "grammy";
import { extractAddress, answerTokenQuestion, stripAddress } from "./rugcheck-handler.js";
import { formatChatReply, formatRugReport } from "./rugcheck.js";
import { sendReport, sendPlain } from "./telegram.js";
import type { PublicClient } from "viem";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

export function registerChatHandler(bot: Bot<any>, client: AnyClient): void {
  bot.on("message:text", async (ctx: Context) => {
    if (!ctx.message || !ctx.message.text || !ctx.chat) return;

    const text = ctx.message.text;

    // /full <address> — full report on demand
    if (text.startsWith("/full")) {
      const address = extractAddress(text);
      if (!address) {
        await ctx.reply("Usage: /full 0x... — sends the complete on-chain report.");
        return;
      }
      await ctx.reply("Running full on-chain rug check…");
      const outcome = await answerTokenQuestion(client, address, undefined, "chat");
      if ("error" in outcome) {
        await ctx.reply(`Couldn't check that token: ${outcome.error}`);
        return;
      }
      await sendReport(ctx.chat.id, formatRugReport(outcome.result, outcome.meta));
      return;
    }

    const address = extractAddress(text);
    if (!address) {
      const isGroup = ctx.chat.type !== "private";
      if (isGroup && !text.includes(`@${ctx.me.username}`)) return;
      await ctx.reply("Send a Base token address (0x...) — or ask me a specific question about one.");
      return;
    }

    // Strip the address so the LLM gets the actual question, not the address itself
    const question = stripAddress(text, address);

    await ctx.reply("Running on-chain rug check…");

    const outcome = await answerTokenQuestion(
      client,
      address,
      question.length > 0 ? question : undefined,
      "chat"
    );

    if ("error" in outcome) {
      await ctx.reply(`Couldn't check that token: ${outcome.error}`);
      return;
    }
    await sendPlain(ctx.chat.id, formatChatReply(outcome.result, outcome.meta));
  });
}
