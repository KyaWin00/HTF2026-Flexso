using { oakhaven.curse as db } from '../db/schema';

/**
 * Ilse's investigation (app src/ilse-app): which records of the village cannot be trusted, and why;
 * what changed when and by whom; and her marks "niet te vertrouwen".
 * Served at /odata/v4/investigation. The signs are in srv/lib/record-doubt.ts.
 * The three "computed" entities have no table: srv/investigation-service.ts builds them on every read
 * from all village records (water, stock, places), so they are always up to date.
 */
service InvestigationService @(path: 'investigation', impl: 'srv/investigation-service') {

  /** Every mark Ilse set, also the ones she lifted (active = false). */
  @readonly
  entity TrustMarks as projection on db.TrustMarks;

  /** Every record with at least one of Ilse's signs, most signs first. */
  @readonly
  @cds.persistence.skip
  entity SuspiciousRecords {
    key ID            : String;     // "<recordType>:<recordId>"
        recordType    : String;     // WaterPipes, Sensors, Repairs, Landmarks, StockItems, ...
        recordId      : String;
        category      : String;     // water | stock | village
        label         : String;     // the record in words
        value         : String;     // its value(s) in words
        changedAt     : Timestamp;  // last change
        changedBy     : String;
        createdAt     : Timestamp;
        createdBy     : String;
        reasons       : String;     // Ilse's signs, comma-separated (see record-doubt.ts)
        reasonCount   : Integer;
        contradiction : String;     // what contradicts what, in words
        marked        : Boolean;    // an active mark "niet te vertrouwen"
  }

  /** Every change of every record (created / last changed), newest first. */
  @readonly
  @cds.persistence.skip
  entity Timeline {
    key ID         : String;
        at         : Timestamp;
        day        : String;        // YYYY-MM-DD, for grouping per day
        hour       : Decimal(5, 2); // hour of the day (as stored), for the night clock
        changedBy  : String;
        action     : String;        // created | modified
        recordType : String;
        recordId   : String;
        label      : String;
        category   : String;
        suspicious : Boolean;
        night      : Boolean;
        nonHuman   : Boolean;
        noName     : Boolean;
        reasons    : String;
  }

  /** Suspicious changes made by the same name in the same minute: "in één keer". */
  @readonly
  @cds.persistence.skip
  entity Bursts {
    key ID     : String;
        at     : Timestamp;
        changedBy : String;
        count  : Integer;
        labels : String;            // the records, "; "-separated
        night  : Boolean;
        nonHuman : Boolean;
  }

  /** Ilse: this record must not be acted on. Returns the (new or existing) active mark. */
  action markUntrusted(recordType : String, recordId : String, label : String, note : String) returns TrustMarks;

  /** Ilse lifts her mark again (only she does, in her app). The mark stays as history. */
  action clearMark(recordType : String, recordId : String) returns Boolean;
}
