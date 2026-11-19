import { billing, coverage } from "./billing";

/** Job priority for this user's uploads and re-processing: 1 when plans are on and the user has one. */
export async function jobPriority(userId: string): Promise<number> {
  if (!billing.enabled()) return 0;
  const c = await coverage(userId);
  return c.personal || c.teams.size ? 1 : 0;
}
