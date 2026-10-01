"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../page.module.css";

/**
 * The sign-in form.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. Whether a password is right, how many
 * times somebody may be wrong, and what a refusal says are all decided on the
 * server, in `lib/auth`, where a test can reach them. This file is two boxes
 * and a button, and it repeats none of that reasoning — a browser deciding
 * whether a password is correct would be a browser that can be told otherwise.
 *
 * THE REFUSAL IS THE SERVER'S OWN SENTENCE, SHOWN UNCHANGED. It deliberately
 * does not say which of the two was wrong, and rewording it here would be a
 * second copy of a sentence whose whole value is that it gives nothing away.
 *
 * THE PASSWORD LIVES IN THIS COMPONENT AND NOWHERE ELSE. It is never put in a
 * URL, never logged, and the box is a real password field so a browser will
 * neither show it nor offer it back on another site.
 */
export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setProblem(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const payload: { ok?: boolean; error?: string } = await response.json();

      if (!response.ok || payload.ok !== true) {
        setProblem(payload.error ?? "Could not sign in.");
        return;
      }

      /*
       * The password is dropped the moment it is no longer needed, so a form
       * left on screen behind a failed navigation is not holding one.
       */
      setPassword("");
      router.replace("/");
      router.refresh();
    } catch {
      // Not reaching this server is not a wrong password, and must not read as one.
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
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>The website audit tool is for Skybook staff.</p>
      </header>

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
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            required
          />
        </label>

        <div>
          <button className={styles.button} type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>

        <p className={styles.exportHint}>
          Need an account? <a href="/register">Request one</a>
        </p>

        {problem !== null && (
          <p className={styles.exportProblem} role="alert">
            {problem}
          </p>
        )}
      </form>
    </main>
  );
}
