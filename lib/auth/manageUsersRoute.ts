/**
 * What the management console decides.
 *
 * MANAGEMENT ONLY, THROUGH ONE DOOR. Every function here opens with
 * `requireRole(MANAGEMENT)`, which reads the acting account from the database
 * each time — so a salesperson, an unsigned request, and a manager whose account
 * was switched off are all turned away alike, and the manager who IS let through
 * is a real, current one whose id can be recorded against what they do.
 *
 * IT MOVES ACCOUNTS THROUGH THEIR LIFECYCLE, AND NOTHING ELSE. Approve, reject,
 * deactivate, reactivate, and set a password. It NEVER changes a role — no
 * action reads a role from the request, and none is passed to the database — and
 * it NEVER deletes an account. The one thing a manager cannot do to themselves
 * is change their own status, so no slip of the hand locks the console.
 *
 * THE PASSWORD HASH NEVER LEAVES. A listed user is projected to everything about
 * the account EXCEPT its hash, and a password that is set is hashed with the
 * same scrypt code sign-in checks against and stored, never returned.
 */
import { requireRole, type GuardOptions } from "./guard.ts";
import { hashPassword } from "./credentials.ts";
import { isAcceptablePassword, WEAK_PASSWORD } from "./registerRoute.ts";
import {
  countActiveManagers,
  findById,
  listUsers,
  setPassword,
  setStatus,
  type User,
  type UserStatus,
} from "../users/userRepository.ts";

export interface ManageDeps extends GuardOptions {
  readonly now?: number;
}

/** A user as the console sees one: everything about the account EXCEPT its hash. */
export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly lastLoginAt: Date | null;
  readonly mustChangePassword: boolean;
}

export type ManageResult =
  | { readonly ok: true; readonly status: number; readonly users?: UserView[]; readonly user?: UserView }
  | { readonly ok: false; readonly status: number; readonly error: string };

/* The sentences a manager is told. Generic enough to leak no internals, plain
 * enough to act on. The console's audience is authorised, so "no such user" is
 * not a disclosure here the way it would be on the public sign-in. */
export const FORBIDDEN = "Management access is required.";
export const NO_SUCH_USER = "No such user.";
export const WRONG_STATE = "That account is not in a state this action applies to.";
export const SELF_FORBIDDEN = "You cannot change your own account's status here.";
export const LAST_MANAGER = "That is the only active manager. Activate another manager before switching this one off.";
export const UNKNOWN_ACTION = "That action is not recognised.";
export const UNAVAILABLE = "The action could not be completed. Please try again.";

/** Projects a user to the console's view — explicitly, so the hash cannot slip in. */
function view(u: User): UserView {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    approvedBy: u.approvedBy,
    approvedAt: u.approvedAt,
    lastLoginAt: u.lastLoginAt,
    mustChangePassword: u.mustChangePassword,
  };
}

/** The four status actions, and the transition each performs. */
const TRANSITIONS: Record<string, { from: UserStatus; to: UserStatus }> = {
  approve: { from: "PENDING", to: "ACTIVE" },
  reject: { from: "PENDING", to: "REJECTED" },
  deactivate: { from: "ACTIVE", to: "INACTIVE" },
  reactivate: { from: "INACTIVE", to: "ACTIVE" },
};

/** Every account, for the console. Management only. */
export async function listUsersRoute(request: Request, deps: ManageDeps = {}): Promise<ManageResult> {
  const manager = await requireRole(request, "MANAGEMENT", deps, deps.now);
  if (manager === null) return { ok: false, status: 403, error: FORBIDDEN };

  try {
    const users = await listUsers(deps.db);
    return { ok: true, status: 200, users: users.map(view) };
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
}

/** Only the three fields an action may carry. A role is never among them. */
function submitted(body: unknown): { action: string; userId: string; password: string } {
  if (typeof body !== "object" || body === null) return { action: "", userId: "", password: "" };
  const { action, userId, password } = body as Record<string, unknown>;
  return {
    action: typeof action === "string" ? action : "",
    userId: typeof userId === "string" ? userId : "",
    password: typeof password === "string" ? password : "",
  };
}

/** One management action on one account. Management only. */
export async function manageUserRoute(request: Request, deps: ManageDeps = {}): Promise<ManageResult> {
  const manager = await requireRole(request, "MANAGEMENT", deps, deps.now);
  if (manager === null) return { ok: false, status: 403, error: FORBIDDEN };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const { action, userId, password } = submitted(body);

  try {
    if (action === "set-password") {
      if (!isAcceptablePassword(password)) return { ok: false, status: 400, error: WEAK_PASSWORD };
      const target = await findById(userId, deps.db);
      if (target === null) return { ok: false, status: 404, error: NO_SUCH_USER };

      // A manager-set password is temporary: flag it so the holder can be asked
      // to change it. The hash is stored; the plaintext is never kept or returned.
      const updated = await setPassword(userId, await hashPassword(password), true, deps.db);
      return updated === null
        ? { ok: false, status: 404, error: NO_SUCH_USER }
        : { ok: true, status: 200, user: view(updated) };
    }

    const transition = TRANSITIONS[action];
    if (transition === undefined) return { ok: false, status: 400, error: UNKNOWN_ACTION };

    const target = await findById(userId, deps.db);
    if (target === null) return { ok: false, status: 404, error: NO_SUCH_USER };
    if (target.status !== transition.from) return { ok: false, status: 409, error: WRONG_STATE };

    // Never leave the system with no active manager. A transition that moves an
    // active MANAGEMENT account out of ACTIVE is refused when it is the last one,
    // so no action — not even a slip — can lock the console for everyone. Checked
    // before self-protection, so the sole manager is told WHY rather than merely
    // "not yourself". (reject/approve/reactivate never move an account OUT of
    // ACTIVE, so this only ever bites deactivate.)
    if (target.role === "MANAGEMENT" && transition.from === "ACTIVE" && transition.to !== "ACTIVE") {
      if ((await countActiveManagers(deps.db)) <= 1) {
        return { ok: false, status: 409, error: LAST_MANAGER };
      }
    }

    // Self-protection: a manager may not change their OWN status here, so no slip
    // deactivates the account they are signed in with. (No action touches a role
    // in any case, so a role can never be changed through this door at all.)
    if (userId === manager.id) return { ok: false, status: 400, error: SELF_FORBIDDEN };

    const updated = await setStatus(userId, transition.to, manager.id, deps.db);
    return updated === null
      ? { ok: false, status: 409, error: WRONG_STATE }
      : { ok: true, status: 200, user: view(updated) };
  } catch {
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
}
