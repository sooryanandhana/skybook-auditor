/**
 * The allowance key for a signed-in account, for limits on signed-in work.
 *
 * KEYED ON THE ACCOUNT, NOT THE ADDRESS. Every route that spends an audit or a
 * send already knows which ACTIVE account is asking, so it needs no header at
 * all: two colleagues behind one office address are not one caller, and when no
 * client address can be read they are not lumped into one shared bucket either.
 * The prefix keeps an account id from ever colliding with an address key.
 *
 * ITS OWN FILE, so the audit limiter and the send limiter can both use it
 * without either importing the other: their buckets stay separate.
 */
export function accountLimitKey(userId: string): string {
  return `user:${userId}`;
}
