/**
 * twitter.ts — OAuth 2.0 User Context wrapper around twitter-api-v2.
 *
 * Authenticates with a pre-generated OAuth 2.0 user access token and
 * automatically refreshes it using the refresh token when it expires.
 * The new tokens are written back to the process env so they survive
 * across calls within the same process lifetime.
 *
 * Required env vars:
 *   TWITTER_CLIENT_ID           — OAuth 2.0 Client ID
 *   TWITTER_CLIENT_SECRET       — OAuth 2.0 Client Secret
 *   TWITTER_USER_ACCESS_TOKEN   — current user access token
 *   TWITTER_USER_REFRESH_TOKEN  — refresh token (used to get a new access token)
 *   TWITTER_DRY_RUN             — "false" to post for real
 *
 * Exports:
 *   postThread(tweets, replyToId?) — post a tweet thread, returns tweet IDs
 */

import { TwitterApi } from "twitter-api-v2";
import fs from "fs";
import path from "path";

// ─── Dry-run flag ─────────────────────────────────────────────────────────────

const DRY_RUN = process.env.TWITTER_DRY_RUN !== "false";

// ─── Token refresh ────────────────────────────────────────────────────────────

/**
 * Refreshes the OAuth 2.0 access token using the stored refresh token.
 * Updates process.env and rewrites .env so the new token persists on restart.
 */
async function refreshAccessToken(): Promise<string> {
  const refreshClient = new TwitterApi({
    clientId:     process.env.TWITTER_CLIENT_ID!,
    clientSecret: process.env.TWITTER_CLIENT_SECRET!,
  });

  const { accessToken, refreshToken: newRefreshToken } =
    await refreshClient.refreshOAuth2Token(process.env.TWITTER_USER_REFRESH_TOKEN!);

  console.log("  [twitter] Access token refreshed successfully");

  // Update in-process env so current run keeps working
  process.env.TWITTER_USER_ACCESS_TOKEN  = accessToken;
  if (newRefreshToken) process.env.TWITTER_USER_REFRESH_TOKEN = newRefreshToken;

  // Persist new tokens back to .env so they survive restarts
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    let envContent = fs.readFileSync(envPath, "utf-8");
    envContent = envContent.replace(
      /^TWITTER_USER_ACCESS_TOKEN=.*/m,
      `TWITTER_USER_ACCESS_TOKEN=${accessToken}`
    );
    if (newRefreshToken) {
      envContent = envContent.replace(
        /^TWITTER_USER_REFRESH_TOKEN=.*/m,
        `TWITTER_USER_REFRESH_TOKEN=${newRefreshToken}`
      );
    }
    fs.writeFileSync(envPath, envContent, "utf-8");
  } catch (err) {
    console.warn(`  [twitter] Could not persist refreshed tokens to .env: ${err}`);
  }

  return accessToken;
}

// ─── Get a ready-to-use client ────────────────────────────────────────────────

function getClient(): TwitterApi {
  return new TwitterApi(process.env.TWITTER_USER_ACCESS_TOKEN!);
}

// ─── postThread ───────────────────────────────────────────────────────────────

/**
 * Post an array of tweet strings as a thread.
 * Automatically retries once after refreshing the token on a 401.
 *
 * @param tweets     Each string must be ≤ 280 chars.
 * @param replyToId  Optional: start the thread as a reply to this tweet ID.
 * @returns          Array of posted tweet IDs (fake IDs in dry-run mode).
 */
export async function postThread(
  tweets: string[],
  replyToId?: string
): Promise<string[]> {
  const ids: string[] = [];
  let lastId = replyToId;

  for (const text of tweets) {
    if (DRY_RUN) {
      const label = lastId ? `reply to ${lastId}` : "new tweet";
      console.log(`  [dry-run | ${label}]\n  ${text}\n`);
      const fakeId = `dryrun-${Date.now()}-${ids.length}`;
      ids.push(fakeId);
      lastId = fakeId;
      continue;
    }

    let posted = false;
    // Try up to twice — second attempt uses a refreshed token
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await getClient().v2.tweet(
          text,
          lastId ? { reply: { in_reply_to_tweet_id: lastId } } : undefined
        );
        ids.push(res.data.id);
        lastId = res.data.id;
        console.log(`  [twitter] posted tweet ${res.data.id}`);
        posted = true;
        break;
      } catch (err: any) {
        const status = err?.code ?? err?.status;
        // On 401 (expired token), refresh and retry once
        if (status === 401 && attempt === 1) {
          console.warn("  [twitter] Access token expired — refreshing…");
          try {
            await refreshAccessToken();
            continue; // retry with new token
          } catch (refreshErr) {
            console.error(`  [twitter] Token refresh failed: ${refreshErr}`);
          }
        }
        console.error(`  [twitter] postThread: tweet failed (attempt ${attempt})`);
        console.error(`    HTTP status : ${status ?? "unknown"}`);
        console.error(`    API error   : ${err?.data?.detail ?? err?.data?.title ?? "n/a"}`);
        console.error(`    Full error  : ${JSON.stringify(err?.data ?? err?.message ?? err, null, 2)}`);
        break;
      }
    }

    if (!posted) break; // stop — don't post orphaned follow-up tweets

    // 1.5 s pacing between tweets in a thread
    await new Promise((r) => setTimeout(r, 1_500));
  }

  return ids;
}
