namespace oakhaven.curse;

using { cuid, managed } from '@sap/cds/common';

// Every entity below uses two standard CAP aspects:
//   cuid    → a UUID key field `ID`
//   managed → createdAt, createdBy, modifiedAt, modifiedBy (filled in by CAP on every write)

// ---------------------------------------------------------------------------
// Water — the pipe network that brings water from Silverbrook Spring to the village
// ---------------------------------------------------------------------------

/** Role of a pipe in the network. */
type PipelineType : String enum {
  mainLine;
  branch;
  secondary;
}

/** A water pipe in the Oakhaven supply network. */
entity WaterPipes : cuid, managed {
  /** Human-readable pipe name, e.g. "PRIMARY-MAIN". */
  pipeID          : String;
  /** Route label, e.g. "Silverbrook Spring → Central Market Square". */
  location        : String;
  /** Landmark names (`Landmarks.name`) the pipe runs between, in flow direction. */
  startPoint      : String;
  endPoint        : String;
  pipelineType    : PipelineType;
  diameter        : Decimal(9, 2); // mm
  length          : Decimal(9, 2); // m
  nominalFlowRate : Decimal(9, 2); // L/min — what the pipe carries at full capacity
  currentFlowRate : Decimal(9, 2); // L/min — what it carries right now
  currentPressure : Decimal(9, 2); // PSI   — water pressure right now
  lastMaintenance : DateTime;
  /** When the crew marked the pipe as repaired in the morning round (app "Ochtendronde"). */
  repairedAt      : Timestamp;
  /** Route on the village map in grid units: "x,y x,y …", x/y in [0,8] from the
   *  south-west corner of cell A1 (centre of E6 = "4.5,5.5"), in flow direction. */
  mapPath         : String;
  sensors         : Composition of many Sensors on sensors.pipe = $self;
  repairs         : Composition of many Repairs on repairs.pipe = $self;
}

/** Flow/pressure sensor mounted on a water pipe. */
entity Sensors : cuid, managed {
  pipe        : Association to WaterPipes;
  sensorID    : String;
  flowRate    : Decimal(15, 2); // L/min measured by the sensor
  pressure    : Decimal(15, 2); // PSI measured by the sensor
  lastReading : DateTime;       // when the sensor last reported
}

/** Repair performed on a water pipe. */
entity Repairs : cuid, managed {
  pipe       : Association to WaterPipes;
  repairID   : UUID;
  issue      : String;
  repairDate : DateTime;
  repairedBy : String;
}

/** What a villager notices at their tap. */
type ReportProblem : String enum {
  noWater;
  littleWater;
  leak;
  other;
}

/** A villager reports that the water at their place is not right (sent from src/maren-app). */
entity WaterReports : cuid, managed {
  /** Where: a landmark that gets water through a pipe (`suppliedBy` is filled in). */
  area    : Association to Landmarks;
  problem : ReportProblem;
  /** Free text from the villager, optional. */
  note    : String(500);
  /** Maren marked it as dealt with. */
  handled : Boolean default false;
}

/** Kind of a village landmark. */
type LandmarkKind : String enum {
  spring;
  mill;
  market;
  inn;
  residential;
  bakery;
  farm;
  forest;
}

/** A landmark on the Oakhaven village map (chess-board cell A1…H8). */
entity Landmarks : cuid, managed {
  name       : String;
  kind       : LandmarkKind;
  /** Cell on the village map: column A–H (west → east) + row 1–8 (south → north). */
  gridCell   : String(2);
  /** pipeID of the branch that feeds this area (residential / bakery / farm only). */
  suppliedBy : String;
  /** Maren's order when two pipes fail that are not on the same line: 1 = goes first.
   *  Empty = Maren gave no place in her order. */
  waterPriority : Integer;
  /** Number of households living here, as told by a villager. Empty = unknown. */
  households    : Integer;
}

// ---------------------------------------------------------------------------
// Food — the village pantry
// ---------------------------------------------------------------------------

/** A food product of the village stock. */
entity StockItems : cuid, managed {
  itemID          : String;          // GRAIN, MILK, …
  name            : String;
  unit            : String;          // KG, L, Dozen, Number
  icon            : String;          // sap-icon://… (Tabler icons: sap-icon://ti/<name>)
  currentQuantity : Decimal(9, 2);   // in `unit`
  minStockLevel   : Decimal(9, 2);   // in `unit` — the level the village wants to stay above
  consumptionRate : Decimal(9, 2);   // `unit` per day the village uses up
  /** Days from ordering to delivery, as told by Tobin (e.g. milk ordered today comes tomorrow = 1).
   *  Empty = nobody told us. */
  leadTimeDays    : Integer;
  /** Who delivers it, as told by Tobin. */
  supplier        : String;
  /** One of Tobin's bread ingredients: "Voor mijn brood draait het vooral om bloem, melk en boter". */
  forBread        : Boolean default false;
  receivals       : Composition of many StockReceivals on receivals.item = $self;
}

/** A delivery of a stock item. (No rows yet.) */
entity StockReceivals : cuid, managed {
  item             : Association to StockItems;
  quantityReceived : Decimal(9, 2); // in the item's `unit`
  supplier         : String;
  receivedAt       : DateTime;
}

/** A message about a stock item. (No rows yet.) */
entity Notifications : cuid, managed {
  item         : Association to StockItems;
  message      : String;
  acknowledged : Boolean default false;
}
