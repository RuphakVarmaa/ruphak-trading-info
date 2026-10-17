/** The order of account work inside one engine tick, after main's entries. */

export interface AccountTickSteps {
  /** Main's position pass: marks, stops, targets, trails for every book with exposure. */
  mainExits: () => Promise<void>;
  /** Each follower account's entries on main's signals and its own position pass. */
  followers: { entries: () => Promise<void>; exits: () => Promise<void> }[];
}

/**
 * Main's exit check runs first, right after main's entries; the follower accounts' entries and then
 * their exits come after it, so their reads and quotes never delay main's stops.
 */
export async function mainExitsFirst(s: AccountTickSteps): Promise<void> {
  await s.mainExits();
  for (const f of s.followers) await f.entries();
  for (const f of s.followers) await f.exits();
}
