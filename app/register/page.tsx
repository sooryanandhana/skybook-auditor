"use client";

import { useState } from "react";
import styles from "../page.module.css";

/**
 * The sign-up form.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. Whether an address is valid, whether a
 * password is long enough, whether the address is already taken, and what any
 * of those refusals says are all decided on the server, in `lib/auth`, where a
 * test can reach them. This file is two boxes, a button, and whatever sentence
 * the server sent back.
 *
 * THE ANSWER IS SHOWN UNCHANGED. A successful sign-up and a repeat of an address
 * that already exists return the same sentence, on purpose, so the page cannot
 * be used to find out who has an account. This file does not try to be cleverer
 * than that.
 *
 * THE PASSWORD LIVES IN THIS COMPONENT AND NOWHERE ELSE. It is never put in a
 * URL, never logged, and the box is a real password field.
 */
export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setProblem(null);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const payload: { ok?: boolean; error?: string; message?: string } = await response.json();

      if (!response.ok || payload.ok !== true) {
        setProblem(payload.error ?? "Could not sign up.");
        return;
      }

      // The password is dropped the moment it is no longer needed.
      setPassword("");
      setEmail("");
      setDone(payload.message ?? "Your request has been received.");
    } catch {
      setProblem("Could not reach this server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <span className={styles.logoMark} aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/skybook-digital-logo-white.png" alt="" className={styles.logoImg} />
          </span>
          <p className={styles.brand}>Skybook</p>
        </div>
        <h1 className={styles.title}>Request an account</h1>
        <p className={styles.subtitle}>
          For Skybook sales staff. A manager approves new accounts before they can sign in.
        </p>
      </header>

      {done !== null ? (
        <div className={styles.signIn}>
          <p className={styles.exportDone} role="status">
            {done}
          </p>
          <p className={styles.exportHint}>
            <a href="/login">Back to sign in</a>
          </p>
        </div>
      ) : (
        <form className={styles.signIn} onSubmit={handleSubmit}>
          <label className={styles.sendField}>
            <span className={styles.exportLabel}>Email address</span>
            <input
              className={styles.exportInput}
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              required
            />
          </label>

          <label className={styles.sendField}>
            <span className={styles.exportLabel}>Password</span>
            <input
              className={styles.exportInput}
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
          </label>

          <div>
            <button className={styles.button} type="submit" disabled={busy}>
              {busy ? "Sending…" : "Request account"}
            </button>
          </div>

          <p className={styles.exportHint}>
            Already have an account? <a href="/login">Sign in</a>
          </p>

          {problem !== null && (
            <p className={styles.exportProblem} role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
    </main>
  );
}
