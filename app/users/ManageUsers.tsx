"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
 *
 * THE COUNTS AND THE PENDING PANEL are read from that same list. Nothing here
 * is a sample or a placeholder: before the list arrives the page says it is
 * loading, and an empty list says so.
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

/**
 * Actions that take access away. They ask first, and look different from the
 * ones that grant it. The question is the browser's own dialog, so it is
 * keyboard- and screen-reader-ready without anything new.
 */
const CONFIRM: Record<string, (email: string) => string> = {
  reject: (email) => `Reject the sign-up for ${email}? They will not be able to use the auditor.`,
  deactivate: (email) => `Deactivate ${email}? They will lose access to the auditor until reactivated.`,
};

/** The four statuses, in the order the summary shows them. */
const STATUSES = [
  { key: "PENDING", label: "Pending approval" },
  { key: "ACTIVE", label: "Active" },
  { key: "INACTIVE", label: "Inactive" },
  { key: "REJECTED", label: "Rejected" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  REJECTED: "Rejected",
};

const ROLE_LABEL: Record<string, string> = {
  MANAGEMENT: "Management",
  SALES: "Sales",
};

/** A server timestamp as a short local date, or the raw text if it will not parse. */
function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The account list, or the sentence to show instead. Touches no state. */
async function fetchUsers(): Promise<{ users: UserView[] } | { problem: string }> {
  try {
    const response = await fetch("/api/users");
    const payload: { ok?: boolean; users?: UserView[]; error?: string } = await response.json();
    if (!response.ok || payload.ok !== true || payload.users === undefined) {
      return { problem: payload.error ?? "Could not load users." };
    }
    return { users: payload.users };
  } catch {
    return { problem: "Could not reach this server. Try again in a moment." };
  }
}

export function ManageUsers() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const apply = useCallback((outcome: Awaited<ReturnType<typeof fetchUsers>>) => {
    if ("problem" in outcome) {
      setProblem(outcome.problem);
      return;
    }
    setProblem(null);
    setUsers(outcome.users);
    setLoaded(true);
  }, []);

  const load = useCallback(async () => {
    apply(await fetchUsers());
  }, [apply]);

  // The first load. State is set in the callback, and not at all if the page
  // has already gone.
  useEffect(() => {
    let active = true;
    void fetchUsers().then((outcome) => {
      if (active) apply(outcome);
    });
    return () => {
      active = false;
    };
  }, [apply]);

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

  /** A status action, asking first when it takes access away. */
  function runAction(user: UserView, action: string) {
    const question = CONFIRM[action];
    if (question !== undefined && !window.confirm(question(user.email))) return;
    void act(user.id, action);
  }

  function openReset(userId: string) {
    setResetFor(userId);
    setNewPassword("");
  }

  function closeReset() {
    setResetFor(null);
    setNewPassword("");
  }

  const counts = Object.fromEntries(
    STATUSES.map(({ key }) => [key, users.filter((user) => user.status === key).length]),
  ) as Record<(typeof STATUSES)[number]["key"], number>;
  const pending = users.filter((user) => user.status === "PENDING");

  /** The status buttons for one account, in a given visual size. */
  function statusButtons(user: UserView) {
    return (ACTIONS[user.status] ?? []).map(({ action, label }) => (
      <button
        key={action}
        type="button"
        className={`${styles.teamButton} ${CONFIRM[action] !== undefined ? styles.teamButtonDanger : styles.teamButtonPrimary}`}
        disabled={busy !== null}
        aria-label={`${label} ${user.email}`}
        onClick={() => runAction(user, action)}
      >
        {busy === user.id ? "Working…" : label}
      </button>
    ));
  }

  return (
    <div className={styles.dash}>
      {/* The same top bar as the auditor: the mark, a way back, and Sign out. */}
      <header className={styles.dashTopNav}>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full navigation to the auditor, matching the app's other internal links */}
        <a className={styles.dashBrand} href="/">
          <span className={styles.logoMark} aria-hidden="true">
            <picture>
              <source media="(prefers-color-scheme: dark)" srcSet="/skybook-digital-logo-white.png" />
              <img src="/skybook-digital.jpg.jpeg" alt="" className={styles.dashLogoImg} />
            </picture>
          </span>
          <span className={styles.dashBrandName}>
            Skybook <span className={styles.dashBrandProduct}>Website Audit</span>
          </span>
        </a>

        <nav className={styles.dashTopLinks} aria-label="Primary">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full navigation to the auditor */}
          <a className={styles.dashTopLink} href="/">
            Website auditor
          </a>
          <span className={`${styles.dashTopLink} ${styles.teamTopLinkCurrent}`} aria-current="page">
            Team accounts
          </span>
        </nav>

        <div className={styles.dashTopActions}>
          <SignOut />
        </div>
      </header>

      <main className={styles.dashPage}>
        <section className={styles.teamHero} aria-labelledby="team-title">
          {/*
            A plain link, like the login/register cross-links: a full load back
            to the auditor re-renders the server page and re-reads the session,
            which is exactly what we want on leaving the console.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full navigation to the auditor, matching the app's other internal links */}
          <a className={styles.backLink} href="/">
            ← Back to website auditor
          </a>
          <h1 id="team-title" className={styles.teamTitle}>
            Team Accounts
          </h1>
          <p className={styles.dashLead}>
            Approve new sign-ups, and manage who can use the auditor. Roles are set when an account
            is created and cannot be changed here.
          </p>
        </section>

        {/* Counts of the real list. Shown only once it has loaded. */}
        <section className={styles.teamStats} aria-label="Accounts by status">
          {STATUSES.map(({ key, label }) => (
            <div key={key} className={`${styles.teamStat} ${key === "PENDING" && counts.PENDING > 0 ? styles.teamStatAlert : ""}`}>
              <span className={styles.teamStatValue}>{loaded ? counts[key] : "–"}</span>
              <span className={styles.teamStatLabel}>{label}</span>
            </div>
          ))}
        </section>

        {problem !== null && (
          <p className={styles.teamProblem} role="alert">
            {problem}
          </p>
        )}

        {pending.length > 0 && (
          <section className={`${styles.panelCard} ${styles.teamPending}`} aria-labelledby="pending-heading">
            <div className={styles.panelHead}>
              <h2 id="pending-heading" className={styles.panelTitle}>
                Waiting for approval
              </h2>
              <span className={`${styles.teamTag} ${styles.teamTag_PENDING}`}>{pending.length} pending</span>
            </div>
            <ul className={styles.teamPendingList}>
              {pending.map((user) => (
                <li key={user.id} className={styles.teamPendingItem}>
                  <span className={styles.teamPendingWho}>
                    <span className={styles.teamEmail}>{user.email}</span>
                    <span className={styles.teamMuted}>
                      {ROLE_LABEL[user.role] ?? user.role} · signed up {shortDate(user.createdAt)}
                    </span>
                  </span>
                  <span className={styles.teamActions}>{statusButtons(user)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.panelCard} aria-labelledby="accounts-heading">
          <div className={styles.panelHead}>
            <h2 id="accounts-heading" className={styles.panelTitle}>
              All accounts
            </h2>
            {loaded && <span className={styles.teamMuted}>{users.length} in total</span>}
          </div>

          {!loaded && problem === null ? (
            <p className={styles.panelEmpty} role="status">
              Loading accounts…
            </p>
          ) : !loaded ? (
            <p className={styles.panelEmpty}>The account list could not be loaded.</p>
          ) : users.length === 0 ? (
            <p className={styles.panelEmpty}>No accounts yet.</p>
          ) : (
            <table className={styles.teamTable}>
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserRows
                    key={user.id}
                    user={user}
                    busy={busy}
                    resetOpen={resetFor === user.id}
                    newPassword={newPassword}
                    onPasswordChange={setNewPassword}
                    onOpenReset={() => openReset(user.id)}
                    onCloseReset={closeReset}
                    onSetPassword={() => act(user.id, "set-password", newPassword)}
                    statusButtons={statusButtons(user)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * One account's row, and -- while it is open -- the set-password row under it,
 * spanning the table so the field has room. On narrow screens the CSS turns
 * each row into a card, labelling every value from `data-label`.
 */
function UserRows({
  user,
  busy,
  resetOpen,
  newPassword,
  onPasswordChange,
  onOpenReset,
  onCloseReset,
  onSetPassword,
  statusButtons,
}: {
  user: UserView;
  busy: string | null;
  resetOpen: boolean;
  newPassword: string;
  onPasswordChange: (value: string) => void;
  onOpenReset: () => void;
  onCloseReset: () => void;
  onSetPassword: () => void;
  statusButtons: ReactNode;
}) {
  const fieldId = `new-password-${user.id}`;
  return (
    <>
      <tr className={resetOpen ? styles.teamRowOpen : undefined}>
        <td data-label="Email" className={styles.teamEmail}>
          {user.email}
        </td>
        <td data-label="Role">
          <span className={`${styles.teamTag} ${styles.teamRole}`}>{ROLE_LABEL[user.role] ?? user.role}</span>
        </td>
        <td data-label="Status">
          <span className={`${styles.teamTag} ${styles[`teamTag_${user.status}`] ?? ""}`}>
            {STATUS_LABEL[user.status] ?? user.status}
          </span>
        </td>
        <td data-label="Created">{shortDate(user.createdAt)}</td>
        <td data-label="Last sign-in">{user.lastLoginAt === null ? "Never" : shortDate(user.lastLoginAt)}</td>
        <td data-label="Actions">
          <span className={styles.teamActions}>
            {statusButtons}
            {!resetOpen && (
              <button
                type="button"
                className={`${styles.teamButton} ${styles.teamButtonQuiet}`}
                disabled={busy !== null}
                aria-label={`Set a new password for ${user.email}`}
                onClick={onOpenReset}
              >
                Set password
              </button>
            )}
          </span>
        </td>
      </tr>

      {resetOpen && (
        <tr className={styles.teamResetRow}>
          <td colSpan={6}>
            <form
              className={styles.teamReset}
              onSubmit={(event) => {
                event.preventDefault();
                onSetPassword();
              }}
            >
              <label htmlFor={fieldId} className={styles.teamResetLabel}>
                New password for <strong>{user.email}</strong>
              </label>
              <input
                id={fieldId}
                type="password"
                autoComplete="new-password"
                className={styles.exportInput}
                value={newPassword}
                onChange={(event) => onPasswordChange(event.target.value)}
                disabled={busy !== null}
                aria-describedby={`${fieldId}-hint`}
                autoFocus
              />
              <span id={`${fieldId}-hint`} className={styles.teamMuted}>
                At least 10 characters. Share it with them privately.
              </span>
              <span className={styles.teamActions}>
                <button
                  type="submit"
                  className={`${styles.teamButton} ${styles.teamButtonPrimary}`}
                  disabled={busy !== null || newPassword === ""}
                >
                  {busy === user.id ? "Saving…" : "Set password"}
                </button>
                <button
                  type="button"
                  className={`${styles.teamButton} ${styles.teamButtonQuiet}`}
                  disabled={busy !== null}
                  onClick={onCloseReset}
                >
                  Cancel
                </button>
              </span>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
