"use client";

import { useCallback, useEffect, useState } from "react";
import { SignOut } from "../SignOut";
import styles from "../page.module.css";

/**
 * The management console's screen.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. Who may do what, which transitions are
 * allowed, and what a refusal says are all decided on the server, in
 * `lib/auth/manageUsersRoute`, where tests reach them. This fetches the list,
 * shows a button for each action the status allows, posts the action, and
 * re-fetches. A password set is the one thing it collects, in a field that is
 * cleared the moment it is sent.
 */
interface UserView {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/** The actions each status offers. Mirrors the server; the server is the judge. */
const ACTIONS: Record<string, Array<{ action: string; label: string }>> = {
  PENDING: [
    { action: "approve", label: "Approve" },
    { action: "reject", label: "Reject" },
  ],
  ACTIVE: [{ action: "deactivate", label: "Deactivate" }],
  INACTIVE: [{ action: "reactivate", label: "Reactivate" }],
  REJECTED: [],
};

export function ManageUsers() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const load = useCallback(async () => {
    // Nothing is set synchronously here: every state change happens after the
    // request resolves, so starting this from an effect triggers no cascade.
    try {
      const response = await fetch("/api/users");
      const payload: { ok?: boolean; users?: UserView[]; error?: string } = await response.json();
      if (!response.ok || payload.ok !== true || payload.users === undefined) {
        setProblem(payload.error ?? "Could not load users.");
        return;
      }
      setProblem(null);
      setUsers(payload.users);
    } catch {
      setProblem("Could not reach this server. Try again in a moment.");
    }
  }, []);

  useEffect(() => {
    // The initial list is fetched through /api/users on purpose, so that even
    // the first read passes the same role guard every later action does, rather
    // than being handed down from a cookie-gated render. The guard re-reads the
    // account from the database, which a server-rendered prop would not.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() only setStates after the request resolves
    void load();
  }, [load]);

  async function act(userId: string, action: string, password?: string) {
    if (busy !== null) return;
    setBusy(userId);
    setProblem(null);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId, ...(password === undefined ? {} : { password }) }),
      });
      const payload: { ok?: boolean; error?: string } = await response.json();
      if (!response.ok || payload.ok !== true) {
        setProblem(payload.error ?? "That action could not be completed.");
        return;
      }
      setResetFor(null);
      setNewPassword("");
      await load();
    } catch {
      setProblem("Could not reach this server. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        {/*
          A way back to the auditor and a way out. The console is its own page
          with no sidebar, so without this a manager would be stranded here.
          "Back to auditor" is a plain link (navigation); Sign out reuses the
          shared component unchanged (a POST button, never a prefetchable link).
        */}
        <div className={styles.consoleBar}>
          {/* A plain link, like the login/register cross-links: a full load back
              to the auditor re-renders the server page and re-reads the session,
              which is exactly what we want on leaving the console. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full navigation to the auditor, matching the app's other internal links */}
          <a className={styles.backLink} href="/">
            ← Back to auditor
          </a>
          <SignOut />
        </div>
        <h1 className={styles.title}>Team accounts</h1>
        <p className={styles.subtitle}>Approve new sign-ups, and manage who can use the auditor.</p>
      </header>

      {problem !== null && (
        <p className={styles.exportProblem} role="alert">
          {problem}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td>{user.role}</td>
              <td>{user.status}</td>
              <td>
                {(ACTIONS[user.status] ?? []).map(({ action, label }) => (
                  <button
                    key={action}
                    type="button"
                    className={styles.buttonSecondary}
                    disabled={busy !== null}
                    onClick={() => act(user.id, action)}
                  >
                    {label}
                  </button>
                ))}

                {resetFor === user.id ? (
                  <span>
                    <input
                      type="password"
                      aria-label={`New password for ${user.email}`}
                      autoComplete="new-password"
                      className={styles.exportInput}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      disabled={busy !== null}
                    />
                    <button
                      type="button"
                      className={styles.buttonSecondary}
                      disabled={busy !== null}
                      onClick={() => act(user.id, "set-password", newPassword)}
                    >
                      Set
                    </button>
                    <button
                      type="button"
                      className={styles.buttonSecondary}
                      disabled={busy !== null}
                      onClick={() => {
                        setResetFor(null);
                        setNewPassword("");
                      }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.buttonSecondary}
                    disabled={busy !== null}
                    onClick={() => {
                      setResetFor(user.id);
                      setNewPassword("");
                    }}
                  >
                    Reset password
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
