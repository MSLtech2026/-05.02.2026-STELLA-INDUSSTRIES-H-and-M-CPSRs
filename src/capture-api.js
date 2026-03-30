#!/usr/bin/env node
/**
 * API Capture Helper for MySwissLab+
 *
 * Opens the app in a visible browser and records all API calls made while you
 * manually create a formula. The captured requests/responses are saved to
 * captured-api.json so you can build a faster, headless API-based importer.
 *
 * Usage:
 *   node src/capture-api.js
 *   node src/capture-api.js --output my-capture.json
 *
 * After running:
 *   1. Log into the app in the browser that opens
 *   2. Navigate to Formulas and manually create ONE complete formula
 *   3. Press Ctrl+C in the terminal to stop recording
 *   The captured API calls will be saved to captured-api.json
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const APP_URL = process.env.APP_URL || 'https://production-suite.vercel.app';
const args = process.argv.slice(2);
const outIdx = args.indexOf('--output');
const outputFile = outIdx >= 0 ? args[outIdx + 1] : 'captured-api.json';

const captured = [];

// Patterns to capture (adjust if the app uses a different API prefix)
const API_PATTERNS = [
  /\/api\//,
  /\/trpc\//,
  /graphql/i,
  /supabase/i,
  /firebase/i,
];

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Intercept all requests
  page.on('request', req => {
    const url = req.url();
    if (!API_PATTERNS.some(p => p.test(url))) return;
    const entry = {
      type: 'request',
      method: req.method(),
      url,
      headers: req.headers(),
      postData: req.postData() || null,
      timestamp: Date.now(),
    };
    captured.push(entry);
    console.log(`→ ${req.method().padEnd(6)} ${url}`);
  });

  // Capture responses
  page.on('response', async res => {
    const url = res.url();
    if (!API_PATTERNS.some(p => p.test(url))) return;
    let body = null;
    try {
      body = await res.json();
    } catch {
      try { body = await res.text(); } catch {}
    }
    captured.push({
      type: 'response',
      status: res.status(),
      url,
      body,
      timestamp: Date.now(),
    });
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  console.log(`\n${'═'.repeat(60)}`);
  console.log('Browser is open. Perform ONE complete formula creation manually.');
  console.log('When done, press Ctrl+C here to save the capture.');
  console.log(`${'═'.repeat(60)}\n`);

  // Keep running until user presses Ctrl+C
  await new Promise(resolve => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });

  const outPath = path.resolve(outputFile);
  fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
  console.log(`\nSaved ${captured.length} API interactions to: ${outPath}`);

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
