/**
 * Rowan's money numbers and Ilse's warning signs, for the council overview (src/rowan-app).
 *
 * Every value below was confirmed by a villager in the HTF chat; their words are quoted next to it.
 * Anything they did not tell us (who goes first when the money runs out, when food is "too little")
 * is deliberately NOT decided here.
 */

// Rowan: "Elke week hebben we 500 kronen te verdelen."
export const WEEK_BUDGET = 500;
// Rowan: "een leiding herstellen, dat kost ongeveer 120 kronen"
export const PIPE_REPAIR_COST = 120;
// Rowan: "een noodlevering van eten, wat ongeveer 80 kronen extra kost … alleen die 80 extra gaat van onze 500 af"
export const EMERGENCY_DELIVERY_EXTRA = 80;

/** Why a number may not be trusted — each one is a sign Ilse confirmed. */
export type DoubtReason = 'negative' | 'futureDate' | 'impossibleFlow' | 'system' | 'night';

/** Who changed a record and when (the `managed` fields). */
export interface ChangeInfo {
  readonly modifiedAt: string | null;
  readonly modifiedBy: string | null;
}

// Ilse: changed by "system" — "geen mens van vlees en bloed"
const MACHINE_USER = 'system';
// Ilse: changed between midnight and 4 am — nobody works then (Tobin is the earliest, up at 4).
// The data stores times in UTC ("…Z"), so the hour is read in UTC.
const NIGHT_END_HOUR = 4;

/** Signs in who/when a record was last changed. */
export function changeDoubts(change: ChangeInfo): DoubtReason[] {
  const reasons: DoubtReason[] = [];
  if (change.modifiedBy === MACHINE_USER) reasons.push('system');
  if (change.modifiedAt) {
    const hour = new Date(change.modifiedAt).getUTCHours();
    if (hour < NIGHT_END_HOUR) reasons.push('night');
  }
  return reasons;
}

/** Ilse: a date in the future cannot be true (e.g. a repair dated 2026-12-30). */
export function isFuture(date: string | null, now: number): boolean {
  return date !== null && Date.parse(date) > now;
}

/** Unique reasons as a comma-separated list for the API ("" = nothing found). */
export function joinReasons(reasons: Iterable<DoubtReason>): string {
  return [...new Set(reasons)].join(',');
}
