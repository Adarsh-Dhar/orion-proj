# Base Token Watchdog + Telegram Bot

A Telegram bot that monitors new token launches on Base, runs AI-powered rug checks, and posts alerts to channels.

| Tool | What it does | Command |
|---|---|---|
| **Telegram Bot** | Scans new Uniswap V3 pools on Base, runs LLM rug checks, and posts alerts to Telegram | `npm run telegram-bot` |
| **Chat** | Terminal Q&A loop backed by Gemini, primed as a DeFi / Base blockchain assistant | `npm run chat` |
| **Sniper** | Historical scanner for analyzing past token launches | `npm run sniper` |
| **Scan** | Scan a specific block range for token launches | `npm run scan` |

---

## Prerequisites

- **Node.js 18+**
- **A Base RPC endpoint**
  The public endpoint (`https://mainnet.base.org`) works for testing but rate-limits aggressively. For sustained use, get a free dedicated URL from [Alchemy](https://alchemy.com), [QuickNode](https://quicknode.com), or [Infura](https://infura.io) — create a "Base mainnet" app and copy the HTTPS URL.
- **A Gemini API key**
  Get one for free at [Google AI Studio](https://aistudio.google.com/).
- **A Telegram bot**
  Create a bot via [@BotFather](https://t.me/botfather) on Telegram and get your bot token.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example and fill in your values:

```bash
cp .env .env.local   # optional — or edit .env directly
```

Open `.env` and set:

```env
# Your Base RPC endpoint (replace with your Alchemy/QuickNode/Infura URL)
RPC_URL=https://mainnet.base.org

# Your Gemini API key from https://aistudio.google.com/
GEMINI_API_KEY=your_key_here

# Gemini model — swap for a more powerful model if needed
GEMINI_MODEL=gemini-2.0-flash-lite

# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Telegram chat ID for sniper notifications (channel/group ID)
TELEGRAM_NOTIFY_CHAT_ID=your_chat_id_here
```

> `.env` is listed in `.gitignore` and will never be committed.

---

## Running

### Telegram Bot

```bash
npm run telegram-bot
```

Starts the Telegram bot that:
- Scans new Uniswap V3 pools on Base every 5 minutes
- Runs AI-powered rug checks on each new token
- Posts formatted reports to your configured Telegram channel
- Responds to user messages with token addresses by running rug checks

The bot will continue running until stopped with **Ctrl+C**.

### Chat

```bash
npm run chat
```

Opens a terminal Q&A loop. Type your question and press Enter. The assistant maintains full conversation history for the session (in memory only — nothing written to disk).

```
You: What is a Uniswap V3 concentrated liquidity pool?
Assistant: A Uniswap V3 concentrated liquidity pool lets LPs allocate capital
within a specific price range rather than across the entire price curve...

You: What are the fee tiers?
Assistant: Uniswap V3 has four fee tiers: 0.01%, 0.05%, 0.30%, and 1.00%...
```

Press **Ctrl+C** to exit.

---

## Project structure

```
src/
  telegram-bot.ts    # Entry point: Telegram bot with sniper + chat
  chat.ts            # Entry point: Terminal chat loop
  sniper.ts          # Historical sniper scanner
  scan-historical.ts # Block range scanner
  lib/
    constants.ts     # Contract addresses, ABIs, known quote assets
    erc20.ts         # Defensive ERC-20 metadata fetcher
    telegram.ts      # Telegram Bot API wrapper
    chat-handler.ts  # Grammy message handler
    rugcheck-handler.ts # Shared token analysis pipeline
    rugcheck.ts      # LLM-powered rug check engine
    scan-engine.ts   # Block scanning logic
    state.ts         # Bot state persistence
.env                 # Secrets (never commit)
package.json
tsconfig.json
```

---

## What's not built yet (next layers)

- **Aerodrome DEX support** — `PairCreated` event on Base's dominant meme-token DEX
- **Chat ↔ sniper bridge** — letting the chat agent query what the sniper has detected
- **Advanced filtering** — more sophisticated risk thresholds and notification rules
# orion-proj
