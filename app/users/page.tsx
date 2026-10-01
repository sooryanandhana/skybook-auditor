import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, readSession } from "@/lib/auth/session";
import { AFTER_LOGIN, LOGIN_PATH } from "@/lib/auth/loginRoute";
import { ManageUsers } from "./ManageUsers";

/**
 * The management console, behind the sign-in AND behind the role.
 *
 * A COURTESY GATE, not the boundary. Like the dashboard, this reads the signed
 * cookie to decide what to render: no session is sent to sign in, and a SALES
 * session is sent to the ordinary dashboard rather than shown a console it may
 * not use. The real boundary is `/api/users`, which calls `requireRole` and
 * re-reads the account from the database on every request — so a stale cookie
 * buys a look at an empty shell and nothing more.
 */
export default async function UsersPage() {
  const store = await cookies();
  const session = readSession(store.get(SESSION_COOKIE)?.value);

  if (session === null) redirect(LOGIN_PATH);
  if (session.role !== "MANAGEMENT") redirect(AFTER_LOGIN);

  return <ManageUsers />;
}
