using { oakhaven.curse as db } from '../db/schema';

/**
 * Water data of Oakhaven: pipes, their sensors and repairs, and the village landmarks.
 * Served at /odata/v4/water-supply — try http://localhost:4004/odata/v4/water-supply/WaterPipes
 */
// `impl` points CAP at the TypeScript handler file (written without the `.ts` extension).
service WaterSupplyService @(path: 'water-supply', impl: 'srv/water-supply-service') {

  @readonly
  entity WaterPipes as projection on db.WaterPipes {
    *,
    // 👋 EXAMPLE — a computed field. `virtual` = part of the API, but not a column in the database.
    //    CAP returns null for it until a handler fills it in: see addDaysSinceMaintenance in
    //    water-supply-service.ts. Shown as a column in src/oakhaven-app/webapp/view/Main.view.xml.
    virtual null as daysSinceMaintenance : Integer
  };

  @readonly
  entity Sensors    as projection on db.Sensors;

  @readonly
  entity Repairs    as projection on db.Repairs;

  @readonly
  entity Landmarks  as projection on db.Landmarks;

  /** What villagers report about the water at their place; newest first in the app. */
  @readonly
  entity WaterReports as projection on db.WaterReports {
    *,
    area.name       as place  : String,
    area.suppliedBy as pipeID : String
  } actions {
    /** Maren: this report is dealt with. */
    action markHandled() returns WaterReports;
  };

  /** A villager reports a problem with the water at their place. */
  action reportProblem(area_ID : UUID, problem : String, note : String) returns WaterReports;

  /** The crew: this pipe is repaired. It leaves today's list, gets a line in the repair history,
   *  and the open reports of the places it feeds are closed. */
  action markRepaired(pipe_ID : UUID) returns Boolean;

  /**
   * Maren's morning round (app src/maren-app): every pipe with its level and its place in her
   * visiting order, sorted — first visit first. The rules are in srv/lib/morning-round.ts; all
   * virtual fields are filled in by planMorningRound in water-supply-service.ts.
   */
  @readonly
  @cds.redirection.target: false
  entity MorningRound as projection on db.WaterPipes {
    ID, pipeID, location, startPoint, endPoint, pipelineType,
    nominalFlowRate, currentFlowRate, currentPressure, mapPath,
    virtual null as level             : String,  // 'alarm' | 'attention' | 'ok'
    virtual null as flowPercent       : Integer, // current flow as % of normal
    virtual null as lowFlow           : Boolean, // below the flow limit of its level
    virtual null as lowPressure       : Boolean, // below the pressure limit of its level
    virtual null as visitOrder        : Integer, // 1 = go first; null = no visit needed
    virtual null as today             : Boolean, // one of today's (max. 2) repairs
    virtual null as servedAreas       : String,  // landmarks behind this pipe, comma-separated
    virtual null as households        : Integer, // households behind it, where known
    virtual null as nobodyDependsOnIt : Boolean,
    virtual null as whyBeforeNext     : String,  // WhyCode in srv/lib/morning-round.ts
    virtual null as downstreamPipes   : String,  // pipeIDs that run dry if this one fails
    virtual null as measuredLevel     : String,  // level from the measurements alone
    virtual null as reportedProblem   : String,  // most serious open report (noWater, littleWater, leak, other)
    virtual null as raisedByReport    : Boolean, // the level comes from a villager's report
    virtual null as doubtSigns        : String,  // Ilse's signs (srv/lib/data-doubt.ts), comma-separated
    virtual null as repairedToday     : Boolean, // the crew marked it as repaired today
    virtual null as daySlot           : Integer  // 1 = morning, 2 = afternoon (today's visits only)
  };

  /** Only today's visits (at most two: "meer dan twee per dag lukt ons niet"), first one first. */
  @readonly
  @cds.redirection.target: false
  entity TodayStops as projection on MorningRound;

  /** The visits that wait until a later day, in Maren's order. */
  @readonly
  @cds.redirection.target: false
  entity LaterStops as projection on MorningRound;
}
