/**
 * Ilse Vermeer's signs that a record of the village cannot be trusted. Pure rules, no database:
 * the investigation service hands in the records, this module says which signs each one shows.
 * Every sign was named by Ilse in the HTF chat; her words are quoted next to it.
 * "Voor mij is één teken al genoeg om een regel op mijn lijst te zetten. Maar ik wil bij elke regel
 *  wél álle redenen zien" → every function returns ALL signs, never just the first.
 */

/** One of Ilse's signs. */
export type Sign =
  | 'negative' // a quantity below zero
  | 'futureDate' // a date after today
  | 'nonHuman' // changed by a name that is no human ("system")
  | 'noName' // changed without a name
  | 'night' // changed between midnight and 4 am
  | 'tooHigh' // a meter measures more than its pipe can carry
  | 'contradiction'; // two sources that should agree, don't

/** Who created and changed a record, and when (CAP's `managed` fields). */
export interface Stamp {
  readonly createdBy: string | null;
  readonly createdAt: string | null;
  readonly modifiedBy: string | null;
  readonly modifiedAt: string | null;
}

// "'system' is geen mens van vlees en bloed"
const NON_HUMAN_NAMES: ReadonlySet<string> = new Set(['system']);
// "of het een naam was die geen mens is, of helemaal geen naam" — CAP writes 'anonymous' when
// nobody is logged in.
const NO_NAMES: ReadonlySet<string> = new Set(['', 'anonymous']);
// "hier werkt niemand tussen middernacht en vier uur 's nachts, want Tobin is de vroegste en die
//  staat pas om vier op" — times as stored in the village records (Ilse herself says "03:13").
const NIGHT_UNTIL_HOUR = 4;
/**
 * "Twee bronnen die hetzelfde zouden moeten zeggen maar het niet doen, zoals een leiding en haar eigen
 *  sensor … Welke regels dat precies zijn, moeten jullie zelf uitzoeken."
 * Our rule: a meter and its pipe contradict each other when they differ by more than 10 %.
 */
export const CONTRADICTION_SHARE = 0.1;

export function isNonHuman(name: string | null): boolean {
  return name !== null && NON_HUMAN_NAMES.has(name.trim().toLowerCase());
}

export function isNoName(name: string | null): boolean {
  return name === null || NO_NAMES.has(name.trim().toLowerCase());
}

/** Between midnight and 4 am, as stored. */
export function isNight(at: string | null): boolean {
  return !!at && new Date(at).getUTCHours() < NIGHT_UNTIL_HOUR;
}

/** "een datum in de toekomst kan gewoon niet waar zijn" */
export function isFuture(at: string | null, now: Date): boolean {
  return !!at && new Date(at).getTime() > now.getTime();
}

/** Two values that should be the same differ by more than {@link CONTRADICTION_SHARE}. */
export function contradicts(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && Math.abs(a - b) / base > CONTRADICTION_SHARE;
}

/** The signs of ONE change (who, when) — used for the timeline. */
export function changeSigns(by: string | null, at: string | null, now: Date): Sign[] {
  const signs: Sign[] = [];
  if (isNonHuman(by)) signs.push('nonHuman');
  else if (isNoName(by)) signs.push('noName');
  if (isNight(at)) signs.push('night');
  if (isFuture(at, now)) signs.push('futureDate');
  return signs;
}

/** The signs in who created and changed a record (both changes count). */
export function stampSigns(stamp: Stamp, now: Date): Sign[] {
  return unique([
    ...changeSigns(stamp.createdBy, stamp.createdAt, now),
    ...changeSigns(stamp.modifiedBy, stamp.modifiedAt, now),
  ]);
}

export function unique(signs: readonly Sign[]): Sign[] {
  return [...new Set(signs)];
}
