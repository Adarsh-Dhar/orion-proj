/**
 * generate-token.ts — one-time OAuth 2.0 PKCE token generator.
 *
 * Run once:  npm run generate-token
 *
 * Opens a local server on port 3000, prints an authorization URL.
 * You open that URL in a browser, approve access, and the script
 * prints the access token to paste into TWITTER_USER_ACCESS_TOKEN in .env.
 *
 * Required env vars (must be set before running):
 *   TWITTER_CLIENT_ID
 *   TWITTER_CLIENT_SECRET
 *
 * The Callback URL in your Twitter app settings must include:
 *   http://localhost:3000/callback
 */

import "dotenv/config";
import http   from "http";
import { URL } from "url";
import { TwitterApi } from "twitter-api-v2";

const CLIENT_ID     = process.env.TWITTER_CLIENT_ID!;
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET!;
const CALLBACK_URL  = "http://localhost:3000/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET must be set in .env");
  process.exit(1);
}

const client = new TwitterApi({
  clientId:     CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

// Generate the PKCE auth link — scopes needed: tweet.read tweet.write users.read
const { url, codeVerifier, state } = client.generateOAuth2AuthLink(CALLBACK_URL, {
  scope: ["tweet.read", "tweet.write", "users.read", "offline.access"],
});

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Twitter OAuth 2.0 Token Generator");
console.log("═══════════════════════════════════════════════════════════════");
console.log("\n  1. Open this URL in your browser:\n");
console.log(`     ${url}\n`);
console.log("  2. Approve access for your bot account.");
console.log("  3. The token will be printed here automatically.\n");
console.log("═══════════════════════════════════════════════════════════════\n");

// Minimal local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const params     = new URL(req.url, "http://localhost:3000").searchParams;
  const code       = params.get("code");
  const returnedState = params.get("state");

  if (!code || returnedState !== state) {
    res.writeHead(400);
    res.end("Bad request — state mismatch or missing code.");
    console.error("\n[error] State mismatch or missing code. Try again.");
    server.close();
    return;
  }

  try {
    const { accessToken, refreshToken, expiresIn } =
      await client.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri: CALLBACK_URL,
      });

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Success! You can close this tab and check your terminal.</h2>");

    console.log("  ✅ Token generated successfully!\n");
    console.log("  Copy this into your .env file:\n");
    console.log(`  TWITTER_USER_ACCESS_TOKEN=${accessToken}`);
    if (refreshToken) {
      console.log(`  TWITTER_REFRESH_TOKEN=${refreshToken}  (optional — for token refresh)`);
    }
    console.log(`\n  Token expires in: ${expiresIn ? Math.round(expiresIn / 3600) + " hours" : "unknown"}`);
    console.log("\n  Then set TWITTER_DRY_RUN=false and run: npm run twitter-bot\n");
  } catch (err) {
    res.writeHead(500);
    res.end("Token exchange failed — check terminal.");
    console.error("\n[error] Token exchange failed:", err);
  }

  server.close();
});

server.listen(3000, () => {
  console.log("  Waiting for browser callback on http://localhost:3000/callback …\n");
});
