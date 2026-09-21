/**
 * Writes the verified Adems Travel client report to a PDF file.
 *
 *   node tools/client-report/generate.mts [output.pdf]
 *
 * Reads nothing but `lib/clientReport/verifiedReport.ts`. It does not run an
 * audit, fetch the website or call any AI service.
 */
import fs from "node:fs";
import path from "node:path";
import { renderClientReport } from "../../lib/clientReport/render.ts";

const DEFAULT_OUT = path.join(
  "C:\\Users\\pc\\Documents\\web\\audit\\phase 7",
  "Adems_Travel_Website_Audit_Report.pdf",
);

const out = path.resolve(process.argv[2] ?? DEFAULT_OUT);
fs.mkdirSync(path.dirname(out), { recursive: true });
const pdf = await renderClientReport();
fs.writeFileSync(out, pdf);
console.log(`Wrote ${pdf.length.toLocaleString()} bytes to ${out}`);
