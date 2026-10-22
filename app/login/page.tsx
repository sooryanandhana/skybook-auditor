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

  /*
   * THE LAYOUT IS PRESENTATION ONLY: a Skybook-blue welcome panel and a white
   * form panel. The form, its fields, the request it sends and the sentence it
   * shows on a refusal are exactly as above. There is no social sign-in, no
   * "remember me" and no self-service reset because the server offers none; a
   * forgotten password is reset by a manager on the Team Accounts page.
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
            Sign in
          </span>

          <div className={styles.authWelcome}>
            <p className={styles.authWelcomeTitle}>Welcome back</p>
            <p className={styles.authWelcomeText}>
              The website audit tool is for Skybook staff. Check a website&rsquo;s speed, SEO,
              security, and technical health.
            </p>
          </div>
        </section>

        <section className={styles.authFormSide}>
          <span className={styles.authOrbTop} aria-hidden="true" />
          <span className={styles.authOrbBottom} aria-hidden="true" />

          <div className={styles.authPanel}>
            <h1 className={styles.authTitle}>Sign in</h1>

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
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  required
                />
              </label>

              <p className={styles.authNote}>Forgot your password? Ask a manager to set a new one.</p>

              <button className={`${styles.button} ${styles.authSubmit}`} type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>

              {problem !== null && (
                <p className={styles.authProblem} role="alert">
                  {problem}
                </p>
              )}

              <p className={styles.authNote}>
                Need an account?{" "}
                <a className={styles.authLink} href="/register">
                  Request one
                </a>
              </p>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
