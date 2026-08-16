# Base Token Watchdog + Gemini Chat Agent

Two independent CLI tools that share a project:

| Tool | What it does | Command |
|---|---|---|
| **Watchdog** | Listens for new token launches on Base (Uniswap V3 `PoolCreated` events), fetches ERC-20 metadata, and logs structured output | `npm run watchdog` |
| **Chat** | Terminal Q&A loop backed by Gemini, primed as a DeFi / Base blockchain assistant | `npm run chat` |

---

## Prerequisites

- **Node.js 18+**
- **A Base RPC endpoint**
  The public endpoint (`https://mainnet.base.org`) works for testing but rate-limits aggressively. For sustained use, get a free dedicated URL from [Alchemy](https://alchemy.com), [QuickNode](https://quicknode.com), or [Infura](https://infura.io) — create a "Base mainnet" app and copy the HTTPS URL.
- **A Gemini API key**
  Get one for free at [Google AI Studio](https://aistudio.google.com/).

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
```

> `.env` is listed in `.gitignore` and will never be committed.

---

## Running

### Watchdog

```bash
npm run watchdog
```

Connects to Base mainnet and listens for new Uniswap V3 pools. Each new pool triggers a metadata fetch and a structured log line:

```
┌─ NEW TOKEN DETECTED ─────────────────────────────────── 2025-07-10T14:32:01.000Z
│  Address  : 0xabc...
│  Name     : Doge2
│  Symbol   : DOGE2
│  Decimals : 18
│  Supply   : 1,000,000,000 DOGE2
│  Paired   : WETH (0x4200000000000000000000000000000000000006)
│  Fee tier : 1.00%
│  Pool     : 0xdef...
│  Tx       : 0x123...
│  BaseScan : https://basescan.org/tx/0x123...
└──────────────────────────────────────────────────────────
```

Press **Ctrl+C** to stop cleanly.

> **Note on the public RPC:** `mainnet.base.org` doesn't persist eth_filter state between polling ticks, so you may see `filter not found` errors in the log. These are harmless — the watchdog recovers automatically. Use a dedicated RPC endpoint to eliminate them.

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
  watchdog.ts        # Entry point: Base event watcher
  chat.ts            # Entry point: Gemini chat loop
  lib/
    constants.ts     # Contract addresses, ABIs, known quote assets
    erc20.ts         # Defensive ERC-20 metadata fetcher
.env                 # Secrets (never commit)
package.json
tsconfig.json
```

---

## What's not built yet (next layers)

- **Risk scoring** — liquidity lock status, dev wallet concentration, contract renounce check
- **Aerodrome DEX support** — `PairCreated` event on Base's dominant meme-token DEX
- **Chat ↔ watchdog bridge** — letting the chat agent query what the watchdog has detected
- **Twitter/X posting** — auto-tweet on new token detection
# orion-proj
