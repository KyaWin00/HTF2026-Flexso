using { oakhaven.curse as db } from '../db/schema';

/**
 * The council's Monday overview (Rowan): how is each part of the village doing, what would it cost,
 * and can we trust the number? Served at /odata/v4/council — used by src/rowan-app.
 * All `virtual` fields are filled in by srv/council-service.ts.
 */
service CouncilService @(path: 'council', impl: 'srv/council-service') {

  /** The parts of the village that get water through a pipe (homes, bakery, farms). */
  @readonly
  entity Areas as projection on db.Landmarks {
    ID,
    name,
    kind,
    gridCell,
    suppliedBy,
    households,
    /** Worst water level on the line that feeds this area: alarm | attention | ok (Maren's limits). */
    virtual null as waterLevel   : String,
    /** pipeID of the pipe that causes that level (empty when all is ok). */
    virtual null as worstPipe    : String,
    /** Comma-separated DoubtReason codes of the pipes on its line (Ilse's signs). */
    virtual null as doubtReasons : String,
    virtual null as doubtful     : Boolean
  } where suppliedBy is not null and suppliedBy != '';

  @readonly
  entity WaterPipes as projection on db.WaterPipes {
    ID,
    pipeID,
    location,
    nominalFlowRate,
    currentFlowRate,
    currentPressure,
    virtual null as waterLevel   : String,
    virtual null as flowPercent  : Integer,
    /** Place in Maren's visiting order (1 = first); empty when the pipe needs no visit. */
    virtual null as marenOrder   : Integer,
    /** Areas that get their water through this pipe, comma-separated. */
    virtual null as servedAreas  : String,
    virtual null as doubtReasons : String,
    virtual null as doubtful     : Boolean,
    /** Rowan: a repair costs about 120 kronen. */
    virtual null as cost         : Integer
  };

  @readonly
  entity StockItems as projection on db.StockItems {
    ID,
    itemID,
    name,
    unit,
    icon,
    currentQuantity,
    minStockLevel,
    consumptionRate,
    /** currentQuantity / consumptionRate — a fact, not a verdict (Tobin decides when it is too little). */
    virtual null as daysLeft     : Decimal(9, 1),
    virtual null as belowMinimum : Boolean,
    virtual null as doubtReasons : String,
    virtual null as doubtful     : Boolean,
    /** Rowan: an emergency delivery costs about 80 kronen extra from the council budget. */
    virtual null as cost         : Integer
  };

  /** Rowan: the council has 500 kronen to spend every week. */
  function weekBudget() returns Integer;

  /** Why a proposal line costs money (see srv/lib/council-proposal.ts). */
  type ProposalNeed : String enum { noWaterNow; orderTooLate; waterRisk; }

  /** What the proposal does with a line (see srv/lib/council-proposal.ts). */
  type ProposalStatus : String enum { proposed; overBudget; checkFirst; noRule; orderInTime; nobodyAffected; }

  /**
   * Rowan: "als u onze 500 kronen had, gaat het hierheen, en waarom."
   * Computed on every read by srv/council-service.ts — not stored, so no table (persistence.skip).
   * Already sorted: proposed lines first (position 1, 2, …), then the ones left out and why.
   */
  @cds.persistence.skip
  @readonly
  entity ProposalLines {
    key ID           : String;     // "water-<pipeID>" or "food-<itemID>"
        position     : Integer;    // 1, 2, … in the proposal; null = not proposed
        sortOrder    : Integer;
        kind         : String;     // water | food
        ref          : String;     // pipeID or itemID
        title        : String;
        areas        : String;     // parts of the village behind a pipe; empty for food (whole village)
        households   : Integer;
        need         : ProposalNeed;
        status       : ProposalStatus;
        cost         : Integer;    // kronen from the council budget
        cumulative   : Integer;    // proposal total up to this line
        remaining    : Integer;    // budget left after this line
        doubtReasons : String;     // Ilse's signs, comma-separated
        emptyDate    : Date;       // food: the day it runs out without an emergency delivery
  }

  /**
   * Rowan: "vóór het voorstel wil ik op één blad zien hoe het met Oakhaven gaat, water en eten samen
   * per deel van het dorp, met de grootste problemen bovenaan." Computed on every read
   * (srv/lib/village-overview.ts), already sorted worst first. Plain Strings (no named enum types),
   * so UI5 can format them directly.
   */
  @cds.persistence.skip
  @readonly
  entity VillageOverview {
    key area         : String;
        gridCell     : String;     // cell on the village map, A1…H8
        households   : Integer;
        waterLevel   : String;     // alarm | attention | ok (Maren)
        waterCause   : String;     // the pipe behind it
        foodLevel    : String;     // hunger | tight | ok (Tobin: paniek | zenuwachtig | goed)
        foodCause    : String;     // products behind it
        foodCheck    : String;     // products whose number cannot be trusted (Ilse)
        doubtReasons : String;     // Ilse's signs, comma-separated
        severity     : Integer;    // 0 red, 1 orange, 2 fine
        sortOrder    : Integer;
  }

  /**
   * The pipes on the council's village map: route (grid units, flow direction) and Maren's level.
   * Computed on read (no table), like VillageOverview.
   */
  @cds.persistence.skip
  @readonly
  entity MapPipes {
    key pipeID     : String;
        mapPath    : String;     // "x,y x,y …" in grid units from the south-west corner of A1
        waterLevel : String;     // alarm | attention | ok
  }
}
