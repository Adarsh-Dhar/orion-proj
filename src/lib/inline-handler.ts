/**
 * inline-handler.ts — Telegram inline mode handler for RugHound.
 *
 * Allows users to query @RugHoundBot from any chat using inline mode:
 *   @RugHoundBot 0x1234...
 *
 * Two-step process because full rug checks are too slow for Telegram's
 * inline-query timeout:
 * 1. inline_query → answers instantly with a placeholder
 * 2. chosen_inline_result → runs real check, edits message in place
 *
 * Required BotFather setup:
 *   /setinline — enable inline mode
 *   /setinlinefeedback → set to 100% (required for chosen_inline_result)
 *
 * Exports:
 *   registerInlineHandler(bot, client, state) — registers inline query handlers
 */

import { Bot, Context, InlineQueryResultBuilder } from "grammy";
import { extractAddress, answerTokenQuestion } from "./rugcheck-handler.js";
import { formatRugReport, formatChatReply } from "./rugcheck.js";
import type { PublicClient } from "viem";
import type { BotState } from "./state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any>;

export function registerInlineHandler(bot: Bot<any>, client: AnyClient, state?: BotState): void {
  // Step 1: Handle inline queries - return placeholder immediately
  bot.on("inline_query", async (ctx: Context) => {
    if (!ctx.inlineQuery || !ctx.inlineQuery.query) return;

    const query = ctx.inlineQuery.query.trim();
    const address = extractAddress(query);

    if (!address) {
      // No valid address found - return empty results
      await ctx.answerInlineQuery([]);
      return;
    }

    // Return a placeholder result immediately
    const placeholder = InlineQueryResultBuilder.article(
      "rugcheck-placeholder",
      "⏳ Running rug check..."
    ).text(`⏳ Running rug check for ${address.slice(0, 8)}...${address.slice(-4)}\n\nThis may take 10-20 seconds...`);

    await ctx.answerInlineQuery([placeholder], { cache_time: 0 });
  });

  // Step 2: Handle chosen inline result - run real check and edit message
  bot.on("chosen_inline_result", async (ctx) => {
    if (!ctx.chosenInlineResult || !ctx.chosenInlineResult.result_id) return;

    const resultId = ctx.chosenInlineResult.result_id;
    const query = ctx.chosenInlineResult.query;

    // Extract address from the original query
    const address = extractAddress(query);
    if (!address) return;

    try {
      // Run the full rug check
      const outcome = await answerTokenQuestion(client, address as `0x${string}`, undefined, "chat", state);

      if ("error" in outcome) {
        const inlineMessageId = ctx.chosenInlineResult.inline_message_id;
        if (inlineMessageId) {
          await bot.api.editMessageTextInline(inlineMessageId, `❌ Couldn't check that token: ${outcome.error}`);
        }
        return;
      }

      // Format the result (use chat reply format for inline messages to keep it concise)
      const reply = formatChatReply(outcome.result, outcome.meta);

      // Edit the inline message with the actual result
      const inlineMessageId = ctx.chosenInlineResult.inline_message_id;
      if (!inlineMessageId) return;

      await bot.api.editMessageTextInline(inlineMessageId, reply);
    } catch (err) {
      console.error("[inline] Error processing chosen result:", err);
      const inlineMessageId = ctx.chosenInlineResult.inline_message_id;
      if (inlineMessageId) {
        await bot.api.editMessageTextInline(inlineMessageId, "❌ Error running rug check. Please try again.");
      }
    }
  });
}
