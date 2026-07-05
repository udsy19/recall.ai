#!/usr/bin/env node
/**
 * Entry point:
 *   node src/index.js   (reads ../../.env if present)
 * Env: API_TOKEN (default "dev"), PORT (default 3000), SONIOX_API_KEY,
 *      WEBHOOK_URL, WEBHOOK_SECRET, ARTIFACTS_DIR
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from './bot-manager.js';
import { WebhookDispatcher } from './webhooks.js';
import { createApiServer } from './server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env */ }

const dispatcher = new WebhookDispatcher({
  url: process.env.WEBHOOK_URL,
  secret: process.env.WEBHOOK_SECRET,
});
const manager = new BotManager({
  artifactsRoot: process.env.ARTIFACTS_DIR ?? path.join(root, 'artifacts'),
  dispatcher,
  soniox: process.env.SONIOX_API_KEY ? { apiKey: process.env.SONIOX_API_KEY } : undefined,
});

const port = Number(process.env.PORT ?? 3000);
createApiServer({ apiToken: process.env.API_TOKEN ?? 'dev', manager }).listen(port, () => {
  console.log(`recall-clone API on :${port} — POST /api/v1/bot {"meeting_url": ...}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\nshutting down: leaving all calls…');
    await manager.stopAll();
    await dispatcher.drain();
    process.exit(0);
  });
}
