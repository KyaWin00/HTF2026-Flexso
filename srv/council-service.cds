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
}
