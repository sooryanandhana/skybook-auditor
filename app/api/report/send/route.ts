import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
import { sendReportRoute } from "@/lib/api/sendReportRoute";

/**
 * POST /api/report/send
 *
 * An adapter, and nothing else. Every decision — which refusals, which status
 * codes, which sentences, what order they are asked in, whether an allowance is
 * spent — lives in `sendReportRoute`, where it is tested without a server.
 *
 * IT COMPOSES NO EMAIL AND READS NO CONFIGURATION. The sending address, the
 * provider and its key are read on the other side of this call, by the one
 * module that may read them. Nothing about any of it is in this file, and
 * nothing about any of it reaches the browser.
 *
 * THE GUARD IS ASKED TWICE, ON PURPOSE. `sendReportRoute` checks the session
 * as its own first act — it has to, because that is where the order of the
 * checks is tested. Asking again here is not a leftover: every API route in
 * this application guards at its own boundary, a test counts the folder to
 * make sure none was left out, and a rule with an exception in it is a rule
 * nobody can check at a glance. Both answers are the same sentence, so which
 * one a stranger meets makes no difference to them.
 *
 * THE NODE RUNTIME, NOT THE EDGE. A send renders the report with the same
 * renderer the download uses, which drives a headless browser and reads its
 * own bundled fonts from disk. Neither is possible on the edge runtime, and
 * Next.js would otherwise be free to choose.
 */
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for itself.
   * The decision is in lib/auth/guard.ts and is tested there.
   */
  if (requireSession(request) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }

  const result = await sendReportRoute(request);

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  /*
   * THE ADDRESS IT WENT TO, AND NOTHING ELSE. No provider receipt, no message
   * id, no request id: the seam below does not carry them upward and this
   * would have nowhere to get them from even if a caller asked.
   *
   * NOTHING IS STORED. Phase 7 keeps this application database-free, and a
   * sent report is not written down anywhere — not here, not in a log.
   */
  return NextResponse.json(
    { ok: true, recipient: result.recipient },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
