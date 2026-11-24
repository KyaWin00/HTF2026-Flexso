/**
 * Handlers of `CouncilService` (see `council-service.cds`) — Rowan's Monday overview.
 *
 * It decides nothing new: water levels and the visiting order come from Maren's rules
 * (lib/morning-round.ts), food urgency from Tobin's rules (lib/bakery-week.ts), the warning signs
 * from Ilse, the prices and the budget from Rowan (lib/council-rules.ts). This file puts them next
 * to each other; the weekly proposal itself is decided in lib/council-proposal.ts.
 */
import { planIngredient } from './lib/bakery-week';
import { proposeWeek, type FoodFacts, type ProposalLine, type WaterFacts } from './lib/council-proposal';
import { planMorningRound, type LandmarkFacts, type PipeFacts, type PipeLevel } from './lib/morning-round';
import {
  EMERGENCY_DELIVERY_EXTRA,
  PIPE_REPAIR_COST,
  WEEK_BUDGET,
  changeDoubts,
  isFuture,
  joinReasons,
  type DoubtReason,
} from './lib/council-rules';

/** A row as the database returns it. */
type DbRow = Readonly<Record<string, unknown>>;

/** A row as the client receives it: we add the virtual fields to it. */
type ApiRow = Record<string, unknown> & { ID?: string };

/** The slice of a CAP request this file uses. */
interface CdsRequest {
  /** For a READ of one row: its key (`ID`). */
  readonly data: Readonly<Record<string, unknown>>;
}

/** The slice of a CAP service this file uses. */
interface CdsService {
  init(): Promise<void>;
  on(event: string, handler: () => unknown): void;
  on(event: string, entity: string, handler: (req: CdsRequest) => unknown): void;
  after(event: string, entity: string, handler: (results: unknown) => unknown): void;
}

/** The slice of the `cds` facade this file uses. */
interface CdsApi {
  readonly ApplicationService: new (...args: readonly never[]) => CdsService;
  readonly ql: {
    readonly SELECT: {
      from(entity: string): { columns(...columns: readonly string[]): PromiseLike<DbRow[]> };
    };
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds') as CdsApi;
const { SELECT } = cds.ql;

const LEVEL_RANK: Readonly<Record<PipeLevel, number>> = { alarm: 0, attention: 1, ok: 2 };

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined || value === '' ? null : num(value);
}

/** Rows of a READ result: a collection gives an array, a single read gives one object. */
function rowsOf(results: unknown): ApiRow[] {
  return (Array.isArray(results) ? results : [results]).filter(
    (row): row is ApiRow => row !== null && typeof row === 'object',
  );
}

/** What we know about one pipe after applying Maren's and Ilse's rules. */
interface PipeVerdict {
  readonly pipeID: string;
  readonly level: PipeLevel;
  readonly flowPercent: number;
  readonly marenOrder: number | null;
  readonly servedAreas: readonly string[];
  readonly households: number | null;
  readonly nobodyDependsOnIt: boolean;
  readonly doubts: readonly DoubtReason[];
}

/** Reads the water network (5 small tables, one query each) and judges every pipe. */
async function judgeWater(): Promise<{ pipes: Map<string, PipeVerdict>; landmarkNames: Map<string, string> }> {
  const [pipeRows, landmarkRows, sensorRows, repairRows] = await Promise.all([
    SELECT.from('oakhaven.curse.WaterPipes').columns(
      'ID', 'pipeID', 'startPoint', 'endPoint', 'nominalFlowRate', 'currentFlowRate', 'currentPressure',
      'lastMaintenance', 'modifiedAt', 'modifiedBy',
    ),
    SELECT.from('oakhaven.curse.Landmarks').columns('ID', 'name', 'kind', 'suppliedBy', 'waterPriority', 'households'),
    SELECT.from('oakhaven.curse.Sensors').columns('pipe_ID', 'flowRate', 'modifiedAt', 'modifiedBy'),
    SELECT.from('oakhaven.curse.Repairs').columns('pipe_ID', 'repairDate', 'modifiedAt', 'modifiedBy'),
  ]);

  const pipes: PipeFacts[] = pipeRows.map((r) => ({
    ID: str(r.ID) ?? '',
    pipeID: str(r.pipeID) ?? '',
    startPoint: str(r.startPoint) ?? '',
    endPoint: str(r.endPoint) ?? '',
    nominalFlowRate: num(r.nominalFlowRate),
    currentFlowRate: num(r.currentFlowRate),
    currentPressure: num(r.currentPressure),
  }));
  const landmarks: LandmarkFacts[] = landmarkRows.map((r) => ({
    name: str(r.name) ?? '',
    kind: str(r.kind) ?? '',
    suppliedBy: str(r.suppliedBy),
    waterPriority: numOrNull(r.waterPriority),
    households: numOrNull(r.households),
  }));
  const plans = planMorningRound(pipes, landmarks);

  // Ilse's signs, collected per pipe (the pipe itself, its sensors and its repairs).
  const now = Date.now();
  const doubts = new Map<string, DoubtReason[]>(pipes.map((p) => [p.ID, []]));
  const nominal = new Map(pipes.map((p) => [p.ID, p.nominalFlowRate]));
  const change = (r: DbRow): DoubtReason[] => changeDoubts({ modifiedAt: str(r.modifiedAt), modifiedBy: str(r.modifiedBy) });
  for (const r of pipeRows) {
    const list = doubts.get(str(r.ID) ?? '');
    if (!list) continue;
    list.push(...change(r));
    if (isFuture(str(r.lastMaintenance), now)) list.push('futureDate');
  }
  for (const r of sensorRows) {
    const pipeId = str(r.pipe_ID) ?? '';
    const list = doubts.get(pipeId);
    if (!list) continue;
    list.push(...change(r));
    // Ilse: a sensor measuring more than the pipe can carry (SENS-004: 140 L/min on a 50 L/min pipe).
    if (num(r.flowRate) > (nominal.get(pipeId) ?? Infinity)) list.push('impossibleFlow');
  }
  for (const r of repairRows) {
    const list = doubts.get(str(r.pipe_ID) ?? '');
    if (!list) continue;
    list.push(...change(r));
    if (isFuture(str(r.repairDate), now)) list.push('futureDate');
  }

  const verdicts = new Map<string, PipeVerdict>();
  for (const pipe of pipes) {
    const plan = plans.get(pipe.ID);
    if (!plan) continue;
    verdicts.set(pipe.ID, {
      pipeID: pipe.pipeID,
      level: plan.level,
      flowPercent: plan.flowPercent,
      marenOrder: plan.visitOrder,
      servedAreas: plan.servedAreas,
      households: plan.households,
      nobodyDependsOnIt: plan.nobodyDependsOnIt,
      doubts: [...new Set(doubts.get(pipe.ID))],
    });
  }
  const landmarkNames = new Map(landmarkRows.map((r) => [str(r.ID) ?? '', str(r.name) ?? '']));
  return { pipes: verdicts, landmarkNames };
}

/** Fills in the virtual fields of WaterPipes, and returns them in Maren's visiting order. */
async function addPipeVerdicts(results: unknown): Promise<void> {
  const rows = rowsOf(results);
  const { pipes } = await judgeWater();
  for (const row of rows) {
    const v = pipes.get(row.ID ?? '');
    if (!v) continue;
    row.waterLevel = v.level;
    row.flowPercent = v.flowPercent;
    row.marenOrder = v.marenOrder;
    row.servedAreas = v.servedAreas.join(', ');
    row.doubtReasons = joinReasons(v.doubts);
    row.doubtful = v.doubts.length > 0;
    row.cost = PIPE_REPAIR_COST;
  }
  // Worst first: the pipes Maren must visit (in her order), then the rest. A virtual field cannot be
  // sorted by the database, so the (small) list is sorted here.
  if (Array.isArray(results)) {
    const order = (row: ApiRow): number => (typeof row.marenOrder === 'number' ? row.marenOrder : Number.MAX_SAFE_INTEGER);
    rows.sort((a, b) => order(a) - order(b) || String(a.pipeID).localeCompare(String(b.pipeID)));
    results.splice(0, results.length, ...rows);
  }
}

/** Fills in the virtual fields of Areas: the worst pipe on the line that feeds each area. */
async function addAreaVerdicts(results: unknown): Promise<void> {
  const rows = rowsOf(results);
  const { pipes, landmarkNames } = await judgeWater();
  for (const row of rows) {
    const name = landmarkNames.get(row.ID ?? '') ?? '';
    // Every pipe the area gets its water through ("valt een leiding uit, dan zit iedereen erachter ook zonder").
    const line = [...pipes.values()].filter((p) => p.servedAreas.includes(name));
    const worst = line.reduce<PipeVerdict | null>(
      (w, p) => (w === null || LEVEL_RANK[p.level] < LEVEL_RANK[w.level] ? p : w),
      null,
    );
    const doubts = line.flatMap((p) => p.doubts);
    row.waterLevel = worst?.level ?? 'ok';
    row.worstPipe = worst && worst.level !== 'ok' ? worst.pipeID : null;
    row.doubtReasons = joinReasons(doubts);
    row.doubtful = doubts.length > 0;
  }
}

/** Ilse's signs on one StockItems row (needs currentQuantity, modifiedAt, modifiedBy). */
function stockDoubts(item: DbRow): DoubtReason[] {
  const doubts: DoubtReason[] = changeDoubts({ modifiedAt: str(item.modifiedAt), modifiedBy: str(item.modifiedBy) });
  // Ilse: negative stock (BUTTER -3) "kan gewoon niet waar zijn".
  if (num(item.currentQuantity) < 0) doubts.push('negative');
  return doubts;
}

/** Fills in the virtual fields of StockItems (facts + Ilse's signs; no verdict — that is Tobin's). */
async function addStockFacts(results: unknown): Promise<void> {
  const rows = rowsOf(results);
  const items = await SELECT.from('oakhaven.curse.StockItems').columns(
    'ID', 'currentQuantity', 'minStockLevel', 'consumptionRate', 'modifiedAt', 'modifiedBy',
  );
  const byId = new Map(items.map((r) => [str(r.ID) ?? '', r]));
  for (const row of rows) {
    const item = byId.get(row.ID ?? '');
    if (!item) continue;
    const quantity = num(item.currentQuantity);
    const rate = num(item.consumptionRate);
    const doubts = stockDoubts(item);
    row.daysLeft = rate > 0 ? Math.round((quantity / rate) * 10) / 10 : null;
    row.belowMinimum = quantity < num(item.minStockLevel);
    row.doubtReasons = joinReasons(doubts);
    row.doubtful = doubts.length > 0;
    row.cost = EMERGENCY_DELIVERY_EXTRA;
  }
}

/** Reads the pantry (one query) and applies Tobin's ordering rule and Ilse's signs to every item. */
async function judgeFood(): Promise<FoodFacts[]> {
  const items = await SELECT.from('oakhaven.curse.StockItems').columns(
    'itemID', 'name', 'unit', 'currentQuantity', 'minStockLevel', 'consumptionRate', 'leadTimeDays', 'forBread',
    'modifiedAt', 'modifiedBy',
  );
  const today = new Date();
  return items.map((item) => {
    const plan = planIngredient(
      {
        itemID: str(item.itemID), // market day (Saturday) counts double for flour and milk
        quantity: numOrNull(item.currentQuantity),
        comfortLevel: numOrNull(item.minStockLevel),
        usePerDay: numOrNull(item.consumptionRate),
        leadTimeDays: numOrNull(item.leadTimeDays),
        unit: str(item.unit),
      },
      today,
    );
    return {
      itemID: str(item.itemID) ?? '',
      name: str(item.name) ?? '',
      // SQLite returns booleans as 1/0.
      forBread: item.forBread === true || item.forBread === 1,
      advice: plan.advice,
      belowMinimum: num(item.currentQuantity) < num(item.minStockLevel),
      daysAboveComfort: plan.daysAboveComfort,
      doubts: stockDoubts(item),
    };
  });
}

/** The weekly proposal (Rowan): every pipe and food item that needs money, in order, with the reason. */
async function readProposal(req: CdsRequest): Promise<ProposalLine[] | ProposalLine | null> {
  const [{ pipes }, food] = await Promise.all([judgeWater(), judgeFood()]);
  const water: WaterFacts[] = [...pipes.values()].map((p) => ({
    pipeID: p.pipeID,
    level: p.level,
    marenOrder: p.marenOrder,
    servedAreas: p.servedAreas,
    households: p.households,
    nobodyDependsOnIt: p.nobodyDependsOnIt,
    doubts: p.doubts,
  }));
  const lines = proposeWeek(water, food, {
    budget: WEEK_BUDGET,
    repairCost: PIPE_REPAIR_COST,
    emergencyExtra: EMERGENCY_DELIVERY_EXTRA,
  });
  // A read of one line (ProposalLines('water-NORTH-BRANCH-02')) gives that line, or 404 when unknown.
  const id = str(req.data.ID);
  return id === null ? lines : (lines.find((line) => line.ID === id) ?? null);
}

export default class CouncilService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.after('READ', 'WaterPipes', addPipeVerdicts);
    this.after('READ', 'Areas', addAreaVerdicts);
    this.after('READ', 'StockItems', addStockFacts);
    this.on('weekBudget', () => WEEK_BUDGET);
    // Not stored (@cds.persistence.skip): every read computes the proposal from the current data.
    this.on('READ', 'ProposalLines', readProposal);
    return super.init();
  }
}
