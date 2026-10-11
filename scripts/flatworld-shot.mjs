#!/usr/bin/env node
/**
 * Flat-world browser driver for QA evidence: opens the app in Chrome (GPU, via Puppeteer), runs a
 * sequence of steps, and writes screenshots and JSON results.
 *
 *   node scripts/flatworld-shot.mjs steps.json
 *
 * steps.json: { "url": "...", "width": 1600, "height": 1000, "steps": [
 *   { "eval": "js expression (awaited)", "save": "name" },
 *   { "wait": 5000 },
 *   { "waitFor": "js expression that becomes truthy", "timeout": 60000 },
 *   { "shot": "path.png" } ] }
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outDir = spec.outDir || path.dirname(path.resolve(process.argv[2]));
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: spec.headless ?? 'new',
  // Long scripted runs (endurance tests) evaluate for many minutes in one call.
  protocolTimeout: spec.protocolTimeout || 180000,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    `--window-size=${spec.width || 1600},${spec.height || 1000}`,
  ],
  defaultViewport: {
    width: spec.width || 1600,
    height: spec.height || 1000,
    deviceScaleFactor: 1,
  },
});
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) =>
  consoleLines.push(`[${m.type()}] ${m.text()}`.slice(0, 400)),
);
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
const results = {};
const t0 = Date.now();
try {
  await page.goto(spec.url || 'http://localhost:4173/?fw=1', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  for (const step of spec.steps || []) {
    if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
    if (step.waitFor) {
      await page.waitForFunction(step.waitFor, {
        timeout: step.timeout || 60000,
        polling: 500,
      });
    }
    if (step.eval) {
      const value = await page.evaluate(`(async () => (${step.eval}))()`);
      if (step.save) results[step.save] = value;
      if (step.print) console.log(step.save || 'eval', JSON.stringify(value));
    }
    if (step.shot) {
      await page.screenshot({ path: path.resolve(outDir, step.shot) });
      console.log(
        'shot',
        step.shot,
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }
  }
} catch (error) {
  results.error = String(error?.stack || error);
  console.error(error);
} finally {
  results.console = consoleLines.slice(-80);
  const out = path.resolve(outDir, spec.results || 'results.json');
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('results', out);
  await browser.close();
}
