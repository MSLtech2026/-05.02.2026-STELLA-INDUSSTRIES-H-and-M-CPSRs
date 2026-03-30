#!/usr/bin/env node
/**
 * Formula Importer for MySwissLab+
 *
 * Reads a CSV file and automates creation of formulas in the Formulas tab.
 *
 * Usage:
 *   node src/import-formulas.js <csv-file> [options]
 *
 * Options:
 *   --headless        Run browser in headless mode (no visible window)
 *   --url <url>       App URL (default: https://production-suite.vercel.app)
 *   --dry-run         Parse CSV and show what would be imported, without touching the app
 *
 * Credentials (required — provide via .env or environment variables):
 *   APP_EMAIL         Login email
 *   APP_PASSWORD      Login password
 *
 * CSV columns:
 *   formula_name      Required. Name of the formula.
 *   category          Required. Must match a category in the app (e.g. "cream", "serum").
 *   client            Optional. Client name as shown in the app. Leave blank for "No client".
 *   process_type      Required. Must match a process type in the app (e.g. "Hot Process (Emulsion)").
 *   phase_name        Required. Phase name (e.g. "Water Phase", "Oil Phase").
 *   phase_temp        Optional. Temperature label (e.g. "75-80°C", "Room temp", "Below 40°C").
 *   ingredient_name   Required. Exact ingredient name as stored in Inventory.
 *   percentage        Required. Numeric percentage for this ingredient in this phase.
 *   notes             Optional. Any notes for this ingredient line.
 *
 * Rows with the same formula_name are grouped into one formula.
 * Rows with the same formula_name + phase_name are grouped into one phase.
 * Percentages across ALL phases of a formula must sum to exactly 100%.
 */

'use strict';

const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── Config ──────────────────────────────────────────────────────────────────

const APP_URL = process.env.APP_URL || 'https://production-suite.vercel.app';
const EMAIL = process.env.APP_EMAIL;
const PASSWORD = process.env.APP_PASSWORD;

// Delay helpers (ms) – increase if the app is slow
const ANIM_DELAY = 400;
const NETWORK_DELAY = 800;

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  console.log(`
Usage: node src/import-formulas.js <csv-file> [--headless] [--dry-run] [--url <url>]

Credentials must be set as environment variables (or in a .env file):
  APP_EMAIL=your@email.com
  APP_PASSWORD=yourpassword

Example:
  APP_EMAIL=admin@lab.com APP_PASSWORD=secret node src/import-formulas.js templates/formula-template.csv
`);
  process.exit(0);
}

const csvFile = args.find(a => !a.startsWith('--'));
const headless = args.includes('--headless');
const dryRun = args.includes('--dry-run');
const urlIdx = args.indexOf('--url');
const appUrl = urlIdx >= 0 ? args[urlIdx + 1] : APP_URL;

if (!csvFile) {
  console.error('Error: No CSV file specified.');
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const formulas = loadCSV(csvFile);

  if (formulas.length === 0) {
    console.error('No formulas found in CSV.');
    process.exit(1);
  }

  if (dryRun) {
    printDryRun(formulas);
    return;
  }

  if (!EMAIL || !PASSWORD) {
    console.error(
      'Error: APP_EMAIL and APP_PASSWORD must be set.\n' +
      'Create a .env file or pass them as environment variables.'
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  let succeeded = 0;
  let failed = 0;

  try {
    await login(page, appUrl, EMAIL, PASSWORD);
    await navigateToFormulas(page);

    for (const formula of formulas) {
      try {
        console.log(`\n→ Importing: "${formula.name}"`);
        await importFormula(page, formula);
        console.log(`  ✓ Done`);
        succeeded++;
      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}`);
        failed++;
        // Try to close any open modal/dialog before continuing
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(ANIM_DELAY);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Imported: ${succeeded}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function loadCSV(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Group rows → formulas → phases → ingredients
  const formulaMap = new Map();

  for (const row of rows) {
    const fname = row.formula_name;
    if (!fname) continue;

    if (!formulaMap.has(fname)) {
      formulaMap.set(fname, {
        name: fname,
        category: row.category || '',
        client: row.client || '',
        processType: row.process_type || '',
        phases: new Map(),
      });
    }

    const formula = formulaMap.get(fname);
    const pname = row.phase_name;
    if (!pname) continue;

    if (!formula.phases.has(pname)) {
      formula.phases.set(pname, {
        name: pname,
        temperature: row.phase_temp || '',
        ingredients: [],
      });
    }

    const iname = row.ingredient_name;
    if (iname) {
      formula.phases.get(pname).ingredients.push({
        name: iname,
        percentage: row.percentage || '0',
        notes: row.notes || '',
      });
    }
  }

  return Array.from(formulaMap.values()).map(f => ({
    ...f,
    phases: Array.from(f.phases.values()),
  }));
}

// ─── Dry-run preview ─────────────────────────────────────────────────────────

function printDryRun(formulas) {
  console.log(`\nDRY RUN — ${formulas.length} formula(s) would be imported:\n`);
  for (const f of formulas) {
    const totalPct = f.phases
      .flatMap(p => p.ingredients)
      .reduce((sum, i) => sum + parseFloat(i.percentage || 0), 0);

    console.log(`Formula: "${f.name}"`);
    console.log(`  Category: ${f.category}  |  Client: ${f.client || '(none)'}  |  Process: ${f.processType}`);
    console.log(`  Total %: ${totalPct.toFixed(2)}%${Math.abs(totalPct - 100) > 0.01 ? '  ⚠ WARNING: must equal 100%' : '  ✓'}`);
    for (const phase of f.phases) {
      const phasePct = phase.ingredients.reduce((s, i) => s + parseFloat(i.percentage || 0), 0);
      console.log(`  Phase "${phase.name}" [${phase.temperature}]  →  ${phasePct.toFixed(2)}%`);
      for (const ing of phase.ingredients) {
        console.log(`    • ${ing.name.padEnd(40)} ${ing.percentage}%${ing.notes ? `  (${ing.notes})` : ''}`);
      }
    }
    console.log();
  }
}

// ─── Browser automation ───────────────────────────────────────────────────────

async function login(page, url, email, password) {
  console.log('Navigating to app…');
  await page.goto(url, { waitUntil: 'networkidle' });

  // Check if already logged in
  const onFormulas = await page.locator('text=Formulas').first().isVisible().catch(() => false);
  if (onFormulas) {
    console.log('Already logged in.');
    return;
  }

  console.log('Logging in…');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")');
  await page.waitForURL(u => !u.includes('login') && !u.includes('signin'), { timeout: 15000 });
  console.log('Logged in.');
}

async function navigateToFormulas(page) {
  await page.click('a:has-text("Formulas"), nav >> text=Formulas, [href*="formula"]');
  await page.waitForSelector('text=Formula Management', { timeout: 10000 });
  console.log('On Formulas tab.');
}

async function importFormula(page, formula) {
  // Open "Create New Formula" modal
  await page.click('button[title="New Formula"], button:has-text("+"):near(:text("Formulas"))');
  await page.waitForSelector('text=Create New Formula', { timeout: 8000 });

  // Formula Name
  await page.fill(
    'input[placeholder*="Anti-Aging"], input[placeholder*="formula"], label:has-text("Formula Name") + div input, dialog input[type="text"]:not([readonly])',
    formula.name
  );

  // Category
  await selectDropdown(page, 'Category', formula.category);

  // Client
  if (formula.client) {
    await selectDropdown(page, 'Client', formula.client, { optional: true });
  }

  // Process Type
  if (formula.processType) {
    await selectDropdown(page, 'Process Type', formula.processType, { optional: true });
  }

  // Submit modal
  await page.click('button:has-text("Create Formula")');
  await page.waitForSelector('text=Save Now', { timeout: 10000 });
  await page.waitForTimeout(NETWORK_DELAY);

  // Add phases
  for (const phase of formula.phases) {
    await addPhase(page, phase);
  }

  // Save
  await page.click('button:has-text("Save Now")');
  await page.waitForSelector('text=Saved', { timeout: 15000 });
}

async function selectDropdown(page, labelText, value, { optional = false } = {}) {
  if (!value) return;
  try {
    // Try native <select> near label
    const sel = page.locator(`label:has-text("${labelText}") ~ select`).first();
    if (await sel.isVisible({ timeout: 2000 })) {
      await sel.selectOption({ label: value });
      return;
    }
  } catch {}

  try {
    // Fallback: any <select> in the modal ordered by DOM position matching label order
    const selects = page.locator('dialog select, [role="dialog"] select');
    const labels = ['Formula Name', 'Category', 'Client', 'Process Type'];
    const idx = labels.indexOf(labelText);
    if (idx >= 0) {
      await selects.nth(idx > 0 ? idx - 1 : 0).selectOption({ label: value });
      return;
    }
  } catch {}

  if (!optional) {
    console.warn(`  Warning: Could not set "${labelText}" to "${value}"`);
  }
}

async function addPhase(page, phase) {
  await page.click('button:has-text("Add Phase")');
  await page.waitForTimeout(ANIM_DELAY);

  // The newly added phase input should be the last empty name input
  const phaseNameInput = page.locator('input[placeholder*="phase"], input[placeholder*="Phase"], input[placeholder*="name"]').last();
  await phaseNameInput.fill(phase.name);
  await page.keyboard.press('Tab');

  // Set temperature via the label/tag selector if visible
  if (phase.temperature) {
    const tempBtn = page
      .locator('button, span')
      .filter({ hasText: /room temp|°C/i })
      .last();

    // Some apps use a clickable chip/tag to set temperature — try clicking it
    const clicked = await tempBtn.click({ timeout: 2000 }).then(() => true).catch(() => false);

    if (!clicked) {
      // Fallback: find a text input near the phase row
      const tempInput = page.locator('input[placeholder*="temp"], input[placeholder*="°C"]').last();
      await tempInput.fill(phase.temperature).catch(() => {});
    }
  }

  await page.waitForTimeout(ANIM_DELAY);

  // Add each ingredient in this phase
  for (const ingredient of phase.ingredients) {
    await addIngredient(page, ingredient);
  }
}

async function addIngredient(page, ingredient) {
  // Click the "+ Add Ingredient" button inside the current phase
  const addIngBtn = page.locator('button:has-text("Add Ingredient")').last();
  await addIngBtn.click();
  await page.waitForTimeout(ANIM_DELAY);

  // Search/type in the ingredient search box
  const searchInput = page
    .locator('input[placeholder*="Search"], input[placeholder*="ingredient"], input[placeholder*="search"]')
    .last();
  await searchInput.fill(ingredient.name);
  await page.waitForTimeout(NETWORK_DELAY); // wait for dropdown results

  // Click the first matching result
  const firstResult = page
    .locator('[role="option"], [role="listbox"] li, ul[class*="dropdown"] li, div[class*="option"]')
    .filter({ hasText: ingredient.name })
    .first();

  const found = await firstResult.isVisible({ timeout: 3000 }).catch(() => false);
  if (found) {
    await firstResult.click();
  } else {
    // Try pressing Enter to confirm whatever is highlighted
    await searchInput.press('Enter');
    console.warn(`  Warning: ingredient "${ingredient.name}" not found via dropdown; pressed Enter`);
  }

  await page.waitForTimeout(ANIM_DELAY);

  // Set percentage — the last number input in the row
  const pctInput = page.locator('input[type="number"]').last();
  await pctInput.triple_click().catch(async () => await pctInput.click({ clickCount: 3 }));
  await pctInput.fill(String(ingredient.percentage));
  await page.keyboard.press('Tab');

  // Set notes if provided
  if (ingredient.notes) {
    const notesInput = page
      .locator('input[placeholder*="Notes"], input[placeholder*="notes"], textarea[placeholder*="notes"]')
      .last();
    await notesInput.fill(ingredient.notes).catch(() => {});
  }

  await page.waitForTimeout(ANIM_DELAY / 2);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\nFatal error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
