/**
 * telegram.ts — Telegram Bot API wrapper using grammy.
 *
 * Provides a simple interface for sending rug check reports to Telegram
 * chats/channels as monospace blocks or plain text. Telegram supports 4096
 * chars per message, so we split on safe boundaries if needed.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 *
 * Exports:
 *   bot — grammy Bot instance
 *   sendReport(chatId, report) — send a formatted report as monospace block
 *   sendPlain(chatId, text) — send short-form text without monospace formatting
 */

import { Bot } from "grammy";

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

/** Sends a report as a monospace block. Telegram caps messages at 4096 chars —
 *  split on a safe boundary if a report ever exceeds that (rare for your format). */
export async function sendReport(chatId: string | number, report: string): Promise<void> {
  const chunks = splitForTelegram(report);
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, `<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: "HTML" });
  }
}

/** Sends short-form text (alert cards, chat replies) without monospace formatting. */
export async function sendPlain(chatId: string | number, text: string): Promise<void> {
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, chunk);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if ((current + line).length > limit) { chunks.push(current); current = ""; }
    current += line + "\n";
  }
  if (current) chunks.push(current);
  return chunks;
}
