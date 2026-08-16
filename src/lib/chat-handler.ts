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
import { extractAddress, answerTokenQuestion } from "./rugcheck-handler.js";
import { formatRugReport } from "./rugcheck.js";
import { sendReport } from "./telegram.js";
import type { PublicClient } from "viem";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

export function registerChatHandler(bot: Bot<any>, client: AnyClient): void {
  bot.on("message:text", async (ctx: Context) => {
    const text = ctx.message.text;
    const address = extractAddress(text);
    if (!address) {
      // In a group, only respond if the bot was actually mentioned/replied to
      const isGroup = ctx.chat.type !== "private";
      if (isGroup && !text.includes(`@${ctx.me.username}`)) return;
      await ctx.reply("Send a Base token address (0x...) and I'll run a rug check.");
      return;
    }

    await ctx.reply("Running on-chain rug check…");
    
    const outcome = await answerTokenQuestion(client, address, text);
    
    if ("error" in outcome) {
      await ctx.reply(`Couldn't check that token: ${outcome.error}`);
      return;
    }
    await sendReport(ctx.chat.id, formatRugReport(outcome.result, outcome.meta));
  });
}
