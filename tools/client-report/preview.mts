/**
 * Renders every page of a PDF to PNG, for visual checking.
 *
 *   node tools/client-report/preview.mts <input.pdf> <output-dir>
 *
 * Uses headless Chromium's own PDF viewer, so what is checked is what a reader
 * opening the file in Chrome would see. A QA aid only; nothing ships from here.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const [input, outDir] = process.argv.slice(2);
if (input === undefined || outDir === undefined) {
  console.error("usage: preview.mts <input.pdf> <output-dir>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: true });
try {
  const base = pathToFileURL(path.resolve(input)).href;
  const only = process.argv.slice(4).map(Number).filter((n) => n > 0);
  const total = only.length === 1 ? only[0] : 60;
  const wanted = only.length > 1 ? only : Array.from({ length: total }, (_, i) => i + 1);

  // A fresh page per PDF page: the viewer only honours `#page=` on first load.
  for (const n of wanted) {
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    await page.goto(`${base}#toolbar=0&navpanes=0&page=${n}&view=Fit`, { waitUntil: "load" });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await page.screenshot({ path: path.join(outDir, `page-${String(n).padStart(2, "0")}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
