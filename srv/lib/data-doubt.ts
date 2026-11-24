/**
 * Can the numbers of a pipe be trusted? Ilse Vermeer (the village investigator) told us how she
 * recognises a record that cannot be true; this module checks a pipe's records against her signs.
 * It never changes Maren's order: it only tells the crew "check this first", because a false alarm
 * costs the crew half a day.
 */

/** One of Ilse's signs. */
export type DoubtSign = 'meterTooHigh' | 'changedBySystem' | 'changedAtNight' | 'futureDate';

/** Who changed a record, and when (the `managed` fields). */
export interface RecordStamp {
  readonly createdBy: string | null;
  readonly createdAt: string | null;
  readonly modifiedBy: string | null;
  readonly modifiedAt: string | null;
}

/** The records of one pipe that the signs look at. */
export interface PipeRecords {
  readonly nominalFlowRate: number;
  readonly pipe: RecordStamp;
  readonly sensors: readonly (RecordStamp & { readonly flowRate: number })[];
  readonly repairs: readonly (RecordStamp & { readonly repairDate: string | null })[];
}

/** "systeem is geen mens van vlees en bloed" */
const SYSTEM_USER = 'system';
/** "hier werkt niemand tussen middernacht en vier uur 's nachts" (hours as stored, UTC) */
const NIGHT_FROM_HOUR = 0;
const NIGHT_UNTIL_HOUR = 4;

function byMachine(stamp: RecordStamp): boolean {
  return stamp.createdBy === SYSTEM_USER || stamp.modifiedBy === SYSTEM_USER;
}

function atNight(stamp: RecordStamp): boolean {
  return [stamp.createdAt, stamp.modifiedAt].some((at) => {
    if (!at) return false;
    const hour = new Date(at).getUTCHours();
    return hour >= NIGHT_FROM_HOUR && hour < NIGHT_UNTIL_HOUR;
  });
}

/** Ilse's signs that apply to the records of one pipe (empty = nothing suspicious). */
export function doubtSigns(records: PipeRecords, now: Date): DoubtSign[] {
  const stamps: RecordStamp[] = [records.pipe, ...records.sensors, ...records.repairs];
  const signs: DoubtSign[] = [];
  // "een sensor die meer meet dan de leiding kan dragen"
  if (records.nominalFlowRate > 0 && records.sensors.some((s) => s.flowRate > records.nominalFlowRate)) {
    signs.push('meterTooHigh');
  }
  // "system is geen mens van vlees en bloed"
  if (stamps.some(byMachine)) signs.push('changedBySystem');
  // "niemand werkt tussen middernacht en vier uur"
  if (stamps.some(atNight)) signs.push('changedAtNight');
  // "een datum in de toekomst kan gewoon niet waar zijn"
  if (records.repairs.some((r) => r.repairDate !== null && new Date(r.repairDate).getTime() > now.getTime())) {
    signs.push('futureDate');
  }
  return signs;
}
