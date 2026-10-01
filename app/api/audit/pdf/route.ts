import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
import { pdfExportRoute } from "@/lib/api/pdfExportRoute";

/**
 * POST /api/audit/pdf?jobId=...
 *
 * An adapter. Every decision — which refusals, which status codes, which
 * sentences — lives in `pdfExportRoute`, where it is tested.
 *
 * A POST RATHER THAN A GET, and 7A §21 gives two reasons. It carries the
 * client fields in a body, and it does real work: a render launches a browser.
 * It is also not on the polling path, so a results page left open cannot
 * produce a document by itself.
 *
 * THE NODE RUNTIME, NOT THE EDGE. The renderer drives a headless browser and
 * reads its own bundled fonts and mark from disk. Neither is possible on the
 * edge runtime, and Next.js would otherwise be free to choose.
 */
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for
   * itself. The decision is in lib/auth/guard.ts and is tested there.
   */
  if ((await requireSession(request)) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }
  const result = await pdfExportRoute(request);

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  /*
   * NOTHING IS STORED. The bytes go straight to the caller and are forgotten;
   * 7A §4 keeps Phase 7 database-free, and there is no saved copy of a report
   * anywhere.
   *
   * `attachment` so a browser saves it rather than opening it in a viewer that
   * would lose the filename. The filename is built from the audited host by
   * the route, never from anything a caller typed.
   */
  return new Response(new Uint8Array(result.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.pdf.length),
      // A report is about one moment. A cached copy would be about another.
      "Cache-Control": "no-store",
    },
  });
}
