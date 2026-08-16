/**
 * test-telegram.ts — Helper script to test Telegram bot setup
 *
 * This script helps verify that your bot can access the specified chat
 * and provides guidance on fixing common issues.
 */

import "dotenv/config";
import { Bot } from "grammy";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID!;

async function testBot() {
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  Telegram Bot Setup Test");
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`  Bot Token: ${process.env.TELEGRAM_BOT_TOKEN?.slice(0, 20)}...`);
  console.log(`  Target Chat ID: ${chatId}`);
  console.log("══════════════════════════════════════════════════════════════════\n");

  try {
    // Get bot info
    const botInfo = await bot.api.getMe();
    console.log(`✅ Bot is valid: @${botInfo.username} (${botInfo.first_name})`);
    console.log(`   Bot ID: ${botInfo.id}\n`);
  } catch (err) {
    console.error(`❌ Bot token is invalid: ${err}`);
    console.log("   Please check your TELEGRAM_BOT_TOKEN in .env\n");
    process.exit(1);
  }

  try {
    // Try to get chat info
    const chat = await bot.api.getChat(chatId);
    console.log(`✅ Chat found: ${chat.title || 'Private Chat'}`);
    console.log(`   Chat Type: ${chat.type}`);
    console.log(`   Chat ID: ${chat.id}\n`);
  } catch (err: any) {
    console.error(`❌ Cannot access chat ${chatId}: ${err.message}`);
    console.log("\n📋 Common solutions:");
    console.log("   1. Make sure the bot is ADDED to the group/channel");
    console.log("   2. Make sure the bot is an ADMINISTRATOR in the group/channel");
    console.log("   3. Make sure the bot has 'Send Messages' permission");
    console.log("   4. For private chats, start a conversation with the bot first\n");
    
    console.log("📝 To add bot to group:");
    console.log("   1. Open your Telegram group/channel");
    console.log("   2. Go to Group Info → Administrators → Add Administrator");
    console.log("   3. Search for your bot username and add it");
    console.log("   4. Grant 'Send Messages' permission\n");
    
    process.exit(1);
  }

  try {
    // Try to send a test message
    const result = await bot.api.sendMessage(chatId, "🧪 Test message from watchdog bot - setup verification successful!");
    console.log(`✅ Test message sent successfully! Message ID: ${result.message_id}`);
    console.log("   Your bot is properly configured and can send messages to this chat.\n");
  } catch (err: any) {
    console.error(`❌ Cannot send messages to chat: ${err.message}`);
    console.log("\n📋 The bot is in the chat but lacks permission to send messages.");
    console.log("   Please check bot permissions in the group/channel settings.\n");
    process.exit(1);
  }

  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  ✅ All tests passed! Your bot is ready to use.");
  console.log("══════════════════════════════════════════════════════════════════\n");
  
  process.exit(0);
}

testBot().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
