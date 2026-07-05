#!/usr/bin/env node
/**
 * One-time Google sign-in for the bot's persistent Chrome profile.
 *
 *   node src/login.js --out ./artifacts/live-test
 *
 * Opens a real (headful) Chrome window using the SAME persistent profile the
 * bot uses, navigated to Google sign-in. You log in manually — including any
 * 2FA/passkey/CAPTCHA — which is exactly what Google's automation defenses
 * require (scripted password entry gets challenged/blocked). Cookies persist
 * to disk in the profile, so subsequent `cli.js` joins run as a signed-in
 * user and can join personal-account meetings that reject anonymous guests.
 *
 * Nothing is stored except Google's own cookies inside the profile dir — no
 * password ever touches our code.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: args } = parseArgs({
  options: { out: { type: 'string', default: './artifacts' } },
});
const profileDir = path.resolve(args.out, '.chrome-profile');

console.log(`Opening Chrome with the bot profile at:\n  ${profileDir}\n`);
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--disable-blink-features=AutomationControlled', '--lang=en-US'],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://accounts.google.com/');

console.log('A Chrome window is open. Sign in to the Google account the bot should use.');
console.log('Complete any 2FA / passkey / CAPTCHA in that window.');
console.log('When you see your Google account is signed in, come back here.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press ENTER here once sign-in is complete to save and close… ');
rl.close();

// Confirm we actually have a session before declaring success.
await page.goto('https://myaccount.google.com/');
const signedIn = await page
  .getByText(/welcome|personal info|manage your/i)
  .first()
  .isVisible({ timeout: 8000 })
  .catch(() => false);

await context.close();
if (signedIn) {
  console.log('\n✓ Signed-in session saved to the bot profile. Future joins will use it.');
} else {
  console.log('\n⚠ Could not confirm a signed-in session — if joins still fail, run login again.');
}
process.exit(0);
