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

  /*
   * THE LAYOUT IS PRESENTATION ONLY, and the same frame as the sign-in page.
   * The form, the request it sends and the sentence it shows -- including the
   * one answer for a new and an already-used address -- are exactly as above.
   */
  return (
    <main className={styles.auth}>
      <div className={styles.authCard}>
        <section className={styles.authBrand}>
          <div className={styles.authLogo}>
            {/* The icon is Skybook blue, so it sits on a white badge to read on the blue panel. */}
            <span className={styles.authLogoTile} aria-hidden="true">
              <span className={styles.logoMark}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/skybook-digital-logo-white.png" alt="" className={styles.logoImg} />
              </span>
            </span>
            <span className={styles.authLogoText}>
              Skybook <span className={styles.authLogoProduct}>Website Audit</span>
            </span>
          </div>

          <span className={styles.authWatermark} aria-hidden="true">
            Request
          </span>

          <div className={styles.authWelcome}>
            <p className={styles.authWelcomeTitle}>Request access</p>
            <p className={styles.authWelcomeText}>
              For Skybook sales staff. A manager approves new accounts before they can sign in.
            </p>
          </div>
        </section>

        <section className={styles.authFormSide}>
          <span className={styles.authOrbTop} aria-hidden="true" />
          <span className={styles.authOrbBottom} aria-hidden="true" />

          <div className={styles.authPanel}>
            <h1 className={styles.authTitle}>Request an account</h1>

            {done !== null ? (
              <div className={styles.authForm}>
                <p className={styles.authDone} role="status">
                  {done}
                </p>
                <p className={styles.authNote}>
                  <a className={styles.authLink} href="/login">
                    Back to sign in
                  </a>
                </p>
              </div>
            ) : (
              <form className={styles.authForm} onSubmit={handleSubmit}>
                <label className={styles.authField}>
                  <span className={styles.authLabel}>Email address</span>
                  <input
                    className={styles.authInput}
                    type="email"
                    name="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                    required
                  />
                </label>

                <label className={styles.authField}>
                  <span className={styles.authLabel}>Password</span>
                  <input
                    className={styles.authInput}
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                    required
                  />
                </label>

                <button className={`${styles.button} ${styles.authSubmit}`} type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Request account"}
                </button>

                {problem !== null && (
                  <p className={styles.authProblem} role="alert">
                    {problem}
                  </p>
                )}

                <p className={styles.authNote}>
                  Already have an account?{" "}
                  <a className={styles.authLink} href="/login">
                    Sign in
                  </a>
                </p>
              </form>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
