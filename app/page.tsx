import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuditPage } from "./AuditPage";
import { SESSION_COOKIE, readSession } from "@/lib/auth/session";
import { LOGIN_PATH } from "@/lib/auth/loginRoute";

/**
 * The application, behind the sign-in.
 *
 * A SERVER COMPONENT IN FRONT OF THE CLIENT ONE, and that split is the whole
 * point of this file. The audit interface remembers things, has buttons and
 * runs in the browser, so it cannot read a cookie the browser is forbidden to
 * see. This can. It reads the session, and either redirects or hands over.
 *
 * THE REDIRECT HAPPENS BEFORE ANYTHING IS SENT. Rendering the interface and
 * then bouncing somebody from JavaScript would ship the whole application to a
 * stranger and ask them politely to look away. Nothing below this line is
 * rendered for a request without a session.
 *
 * IT IS NOT THE SECURITY BOUNDARY, and must not be mistaken for one. This is
 * the courtesy a person in a browser gets. Every API route checks for itself,
 * through the one guard in `lib/auth`, because a request that never rendered a
 * page never passed through here.
 *
 * THE AUDIT INTERFACE IS UNCHANGED. It moved file and lost its `default`, and
 * that is all: no prop, no context, no knowledge that a sign-in exists.
 */
export default async function HomePage() {
  const store = await cookies();
  const session = readSession(store.get(SESSION_COOKIE)?.value);

  if (session === null) redirect(LOGIN_PATH);

  return <AuditPage />;
}
