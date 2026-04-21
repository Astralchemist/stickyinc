#!/usr/bin/env node
// One-shot OAuth flow: captures auth code via localhost callback and saves tokens.
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import {
  buildAuthUrl,
  CREDS_PATH,
  exchangeCode,
  hasGoogleCreds,
  loadGoogleConfig,
  saveGoogleConfig,
} from "./google.js";

async function main(): Promise<void> {
  if (!hasGoogleCreds()) {
    console.error(
      `Missing Google credentials at ${CREDS_PATH}.\n\n` +
        `1. Go to https://console.cloud.google.com/apis/credentials\n` +
        `2. Create an OAuth 2.0 Client ID, type: "Desktop app"\n` +
        `3. Save the client_id and client_secret to ${CREDS_PATH}:\n\n` +
        `   { "client_id": "...", "client_secret": "..." }\n\n` +
        `Then run this command again.`
    );
    process.exit(1);
  }

  const cfg = loadGoogleConfig();

  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = buildAuthUrl(cfg.client_id, redirectUri);

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);
  console.log(
    `\nWaiting for Google to redirect back to ${redirectUri}... (press Ctrl-C to cancel)\n`
  );

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      try {
        const u = new URL(req.url ?? "/", redirectUri);
        const c = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`OAuth error: ${err}`);
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        if (!c) {
          res.writeHead(400);
          res.end("missing code");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:sans-serif;padding:40px'><h2>StickyInc ✓</h2><p>Authorized. You can close this tab.</p></body></html>"
        );
        resolve(c);
      } catch (e) {
        reject(e as Error);
      }
    });
  });

  server.close();

  const tokens = await exchangeCode(cfg.client_id, cfg.client_secret, code, redirectUri);
  saveGoogleConfig({
    ...cfg,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
  });

  console.log(`✓ Tokens saved to ${CREDS_PATH}. Calendar is live.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
