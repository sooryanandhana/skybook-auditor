"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

/**
 * Signing out.
 *
 * A BUTTON RATHER THAN A LINK, because signing out changes something on the
 * server and a link that changes state is a link something can follow on your
 * behalf. A browser prefetching a link would sign the person out by hovering.
 *
 * IT TOUCHES NOTHING ELSE ON THE PAGE. No audit is stopped, no result is
 * cleared and no report is discarded. The server replaces the cookie and the
 * browser goes to the sign-in page; everything the job store holds is exactly
 * where it was.
 */
export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);

    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const payload: { next?: string } = await response.json();
      router.replace(payload.next ?? "/login");
      router.refresh();
    } catch {
      /*
       * The cookie is still in the browser, so the honest thing is to leave
       * the person signed in rather than pretend otherwise and send them to a
       * page that will bounce them straight back.
       */
      setBusy(false);
    }
  }

  return (
    <button className={styles.signOut} type="button" onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
