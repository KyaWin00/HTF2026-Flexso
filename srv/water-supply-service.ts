/**
 * Handlers of `WaterSupplyService` (see `water-supply-service.cds`).
 *
 * Everything you can read from the service is served by CAP's generic provider — no code needed.
 * Add a handler here only when you need logic: `this.before(...)` to validate, `this.on(...)` to
 * implement an action, `this.after(...)` to enrich what is read.
 *
 * `@sap/cds` ships no TypeScript declarations in this project, so it is loaded with `require`
 * and the part of its API this file uses is described in the small interfaces below.
 */
import { startDemoSensorFeed } from './lib/demo-freshness';
import { planMorningRound, type LandmarkFacts, type PipeFacts, type PipePlan } from './lib/morning-round';
import { doubtSigns, type DoubtSign, type RecordStamp } from './lib/data-doubt';

// 👋 EXAMPLE — the shape of a WaterPipes row as our handler sees it. Every field is optional:
//    the client decides which fields it asks for ($select).
interface PipeRow {
  ID?: string;
  lastMaintenance?: string | null;
  daysSinceMaintenance?: number | null;
}

/** The slice of a CAP service this file uses. */
interface CdsService {
  init(): Promise<void>;
  after(event: string, entity: string, handler: (results: unknown) => unknown): void;
  on(event: string, handler: (req: ActionRequest) => unknown): void;
  on(event: string, entity: string, handler: (req: ActionRequest) => unknown): void;
}

/** The slice of a CAP request an action handler uses. */
interface ActionRequest {
  /** The action's parameters. */
  readonly data: Readonly<Record<string, unknown>>;
  /** For a bound action: a reference to the instance it was called on. */
  readonly subject: unknown;
  error(code: number, message: string, target?: string): void;
}

/** A single-row CQL SELECT. */
interface SelectOneQuery extends PromiseLike<Readonly<Record<string, unknown>> | undefined> {
  where(predicate: Readonly<Record<string, unknown>>): PromiseLike<Readonly<Record<string, unknown>> | undefined>;
}

/** A CQL SELECT with its columns set: await it as is, or narrow it down with `where`. */
interface SelectQuery<T> extends PromiseLike<T[]> {
  where(predicate: Readonly<Record<string, unknown>>): PromiseLike<T[]>;
}

/** The slice of the `cds` facade this file uses. */
interface CdsApi {
  readonly ApplicationService: new (...args: readonly never[]) => CdsService;
  readonly ql: {
    readonly SELECT: {
      from(entity: string): {
        columns<T = PipeRow>(...columns: readonly string[]): SelectQuery<T>;
      };
      readonly one: { from(entity: unknown): SelectOneQuery };
    };
    readonly INSERT: { into(entity: string): { entries(row: Readonly<Record<string, unknown>>): PromiseLike<unknown> } };
    readonly UPDATE: (entity: unknown, key?: unknown) => {
      with(changes: Readonly<Record<string, unknown>>): PromiseLike<number> & {
        where(predicate: Readonly<Record<string, unknown>>): PromiseLike<number>;
      };
    };
  };
  readonly utils: { uuid(): string };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds') as CdsApi;
const { SELECT, INSERT, UPDATE } = cds.ql;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 👋 EXAMPLE — fills in the computed field `daysSinceMaintenance` on every pipe that is read.
 *
 * Registered with `this.after('READ', 'WaterPipes', …)`: CAP has already read the rows from the
 * database and hands them to us just before it sends them to the client — we only add a value.
 */
async function addDaysSinceMaintenance(results: unknown): Promise<void> {
  // 👋 EXAMPLE — reading a collection (/WaterPipes) gives an array; reading one pipe
  //    (/WaterPipes(<ID>)) gives a single object. Treat both the same way.
  const rows = (Array.isArray(results) ? results : [results]).filter(
    (row): row is PipeRow => row !== null && typeof row === 'object',
  );

  // 👋 EXAMPLE — the client may ask for only SOME fields, e.g. `$select=pipeID,daysSinceMaintenance`.
  //    UI5 always does that: it only requests the fields a view binds. Then `lastMaintenance` — the
  //    input we need — is not in the row. CAP always adds the key (`ID`), so we look the missing
  //    inputs up ourselves: ONE query for all rows that need it (never one query per row).
  const missingIds = rows.filter((row) => !('lastMaintenance' in row) && row.ID).map((row) => row.ID);
  const lastMaintenanceById = new Map<string, string | null | undefined>();
  if (missingIds.length > 0) {
    const pipes = await SELECT.from('oakhaven.curse.WaterPipes')
      .columns('ID', 'lastMaintenance')
      .where({ ID: { in: missingIds } });
    for (const pipe of pipes) lastMaintenanceById.set(pipe.ID ?? '', pipe.lastMaintenance);
  }

  // 👋 EXAMPLE — the actual calculation: whole days between the last maintenance and now.
  //    Computed on every read, so it is always up to date — nothing is stored.
  const now = Date.now();
  for (const row of rows) {
    const lastMaintenance = 'lastMaintenance' in row ? row.lastMaintenance : lastMaintenanceById.get(row.ID ?? '');
    row.daysSinceMaintenance = lastMaintenance
      ? Math.floor((now - Date.parse(lastMaintenance)) / MS_PER_DAY)
      : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Maren's morning round (entities MorningRound and TodayStops)
// ---------------------------------------------------------------------------------------------

/** A WaterPipes row as the database returns it (Decimals may arrive as strings). */
interface PipeDbRow {
  ID: string;
  pipeID: string;
  startPoint: string | null;
  endPoint: string | null;
  nominalFlowRate: number | string | null;
  currentFlowRate: number | string | null;
  currentPressure: number | string | null;
  createdBy: string | null;
  createdAt: string | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
  repairedAt: string | null;
}

/** Who changed a record and when — the `managed` fields Ilse's signs look at. */
interface StampDbRow {
  pipe_ID: string | null;
  createdBy: string | null;
  createdAt: string | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
}

/** A Sensors row (only what the doubt signs need). */
interface SensorDbRow extends StampDbRow {
  flowRate: number | string | null;
}

/** A Repairs row (only what the doubt signs need). */
interface RepairDbRow extends StampDbRow {
  repairDate: string | null;
}

/** An open WaterReports row. */
interface ReportDbRow {
  area_ID: string | null;
  problem: string | null;
}

/** A Landmarks row as the database returns it. */
interface LandmarkDbRow {
  ID: string;
  name: string | null;
  kind: string | null;
  suppliedBy: string | null;
  waterPriority: number | null;
  households: number | null;
}

/** A MorningRound row as the client sees it: the plan of {@link PipePlan}, flattened for OData. */
interface RoundRow {
  ID?: string;
  pipeID?: string;
  visitOrder?: number | null;
  today?: boolean | null;
}

function toNumber(value: number | string | null): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Same calendar day (UTC, as stored). */
function isToday(at: string | null, now: Date): boolean {
  return !!at && new Date(at).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

function toPipeFacts(row: PipeDbRow, reports: readonly string[]): PipeFacts {
  return {
    ID: row.ID,
    pipeID: row.pipeID,
    startPoint: row.startPoint ?? '',
    endPoint: row.endPoint ?? '',
    nominalFlowRate: toNumber(row.nominalFlowRate),
    currentFlowRate: toNumber(row.currentFlowRate),
    currentPressure: toNumber(row.currentPressure),
    reports,
    repairedToday: isToday(row.repairedAt, new Date()),
  };
}

function stampOf(row: Omit<StampDbRow, 'pipe_ID'>): RecordStamp {
  return { createdBy: row.createdBy, createdAt: row.createdAt, modifiedBy: row.modifiedBy, modifiedAt: row.modifiedAt };
}

/** Ilse's doubt signs for every pipe, by pipe ID. */
function doubtsByPipe(pipes: readonly PipeDbRow[], sensors: readonly SensorDbRow[], repairs: readonly RepairDbRow[]): Map<string, DoubtSign[]> {
  const now = new Date();
  return new Map(
    pipes.map((pipe) => [
      pipe.ID,
      doubtSigns(
        {
          nominalFlowRate: toNumber(pipe.nominalFlowRate),
          pipe: stampOf(pipe),
          sensors: sensors.filter((s) => s.pipe_ID === pipe.ID).map((s) => ({ ...stampOf(s), flowRate: toNumber(s.flowRate) })),
          repairs: repairs.filter((r) => r.pipe_ID === pipe.ID).map((r) => ({ ...stampOf(r), repairDate: r.repairDate })),
        },
        now,
      ),
    ]),
  );
}

/** Open reports per pipeID: a report about a place counts for the pipe that feeds that place. */
function reportsByPipe(reports: readonly ReportDbRow[], landmarks: readonly LandmarkDbRow[]): Map<string, string[]> {
  const pipeOfArea = new Map(landmarks.map((l) => [l.ID, l.suppliedBy]));
  const byPipe = new Map<string, string[]>();
  for (const report of reports) {
    const pipeID = pipeOfArea.get(report.area_ID ?? '');
    if (!pipeID || !report.problem) continue;
    byPipe.set(pipeID, [...(byPipe.get(pipeID) ?? []), report.problem]);
  }
  return byPipe;
}

function toLandmarkFacts(row: LandmarkDbRow): LandmarkFacts {
  return {
    name: row.name ?? '',
    kind: row.kind ?? '',
    suppliedBy: row.suppliedBy,
    waterPriority: row.waterPriority,
    households: row.households,
  };
}

/** The virtual fields of MorningRound for one plan (lists become comma-separated strings). */
function toRoundFields(plan: PipePlan, doubts: readonly DoubtSign[]): Record<string, unknown> {
  return {
    measuredLevel: plan.measuredLevel,
    reportedProblem: plan.reportedProblem,
    raisedByReport: plan.raisedByReport,
    repairedToday: plan.repairedToday,
    daySlot: plan.daySlot,
    doubtSigns: doubts.join(','),
    level: plan.level,
    flowPercent: plan.flowPercent,
    lowFlow: plan.lowFlow,
    lowPressure: plan.lowPressure,
    visitOrder: plan.visitOrder,
    today: plan.today,
    servedAreas: plan.servedAreas.join(', '),
    households: plan.households,
    nobodyDependsOnIt: plan.nobodyDependsOnIt,
    whyBeforeNext: plan.whyBeforeNext,
    downstreamPipes: plan.downstreamPipes.join(','),
  };
}

/** Visits in Maren's order first, then the pipes that need no visit. */
function byVisitOrder(a: RoundRow, b: RoundRow): number {
  const orderA = a.visitOrder ?? Number.MAX_SAFE_INTEGER;
  const orderB = b.visitOrder ?? Number.MAX_SAFE_INTEGER;
  return orderA - orderB || (a.pipeID ?? '').localeCompare(b.pipeID ?? '');
}

/** Which rows of the round an entity shows. */
type RoundSelection = (row: RoundRow) => boolean;
const ALL_PIPES: RoundSelection = () => true;
const TODAY: RoundSelection = (row) => row.today === true;
const LATER: RoundSelection = (row) => row.visitOrder !== null && row.visitOrder !== undefined && row.today !== true;

/**
 * Fills in the plan of every pipe read from MorningRound / TodayStops / LaterStops and sorts the
 * result. The plan depends on ALL pipes (upstream, people behind it), so it always reads the whole
 * network — two queries, whatever the client asked for. `keep` decides which rows remain.
 * Sorting and filtering happen here because the order is computed, not stored: the network is small
 * (six pipes), so the whole list always fits in one page ($count/$top are not meaningful here).
 */
async function planRound(results: unknown, keep: RoundSelection): Promise<void> {
  const rows = (Array.isArray(results) ? results : [results]).filter(
    (row): row is RoundRow => row !== null && typeof row === 'object',
  );
  if (rows.length === 0) return;

  const stamp = ['pipe_ID', 'createdBy', 'createdAt', 'modifiedBy', 'modifiedAt'];
  const [pipes, landmarks, sensors, repairs, reports] = await Promise.all([
    SELECT.from('oakhaven.curse.WaterPipes').columns<PipeDbRow>(
      'ID', 'pipeID', 'startPoint', 'endPoint', 'nominalFlowRate', 'currentFlowRate', 'currentPressure',
      'createdBy', 'createdAt', 'modifiedBy', 'modifiedAt', 'repairedAt',
    ),
    SELECT.from('oakhaven.curse.Landmarks').columns<LandmarkDbRow>(
      'ID', 'name', 'kind', 'suppliedBy', 'waterPriority', 'households',
    ),
    SELECT.from('oakhaven.curse.Sensors').columns<SensorDbRow>(...stamp, 'flowRate'),
    SELECT.from('oakhaven.curse.Repairs').columns<RepairDbRow>(...stamp, 'repairDate'),
    // Open reports only. Until `npm run db:reset` created the table, there are simply none.
    SELECT.from('oakhaven.curse.WaterReports').columns<ReportDbRow>('area_ID', 'problem').where({ handled: false })
      .then((r) => r, (): ReportDbRow[] => []),
  ]);
  const openReports = reportsByPipe(reports, landmarks);
  const plans = planMorningRound(
    pipes.map((p) => toPipeFacts(p, openReports.get(p.pipeID) ?? [])),
    landmarks.map(toLandmarkFacts),
  );
  const doubts = doubtsByPipe(pipes, sensors, repairs);

  for (const row of rows) {
    const plan = plans.get(row.ID ?? '');
    if (plan) Object.assign(row, toRoundFields(plan, doubts.get(row.ID ?? '') ?? []));
  }
  if (Array.isArray(results)) {
    const ordered = rows.sort(byVisitOrder).filter(keep);
    results.splice(0, results.length, ...ordered);
  }
}

// ---------------------------------------------------------------------------------------------
// Reports from villagers (entity WaterReports, actions reportProblem and markHandled)
// ---------------------------------------------------------------------------------------------

/** The values of the ReportProblem enum in db/schema.cds. */
const REPORT_PROBLEMS: ReadonlySet<string> = new Set(['noWater', 'littleWater', 'leak', 'other']);
const NOTE_MAX_LENGTH = 500;

/** A villager reports a problem at their place: check it, store it, return the new report. */
async function reportProblem(req: ActionRequest): Promise<unknown> {
  const areaId = typeof req.data.area_ID === 'string' ? req.data.area_ID : '';
  const problem = typeof req.data.problem === 'string' ? req.data.problem : '';
  const note = typeof req.data.note === 'string' ? req.data.note.trim() : '';

  if (!REPORT_PROBLEMS.has(problem)) return req.error(400, 'Kies wat je merkt aan het water.', 'problem');
  if (note.length > NOTE_MAX_LENGTH) return req.error(400, `Je opmerking is te lang (max. ${NOTE_MAX_LENGTH} tekens).`, 'note');
  // Only places that get their water through a pipe: otherwise nobody knows which pipe to check.
  const area = areaId ? await SELECT.one.from('oakhaven.curse.Landmarks').where({ ID: areaId }) : undefined;
  if (!area || !area.suppliedBy) return req.error(400, 'Kies de plek waar je woont of werkt.', 'area_ID');

  const ID = cds.utils.uuid();
  await INSERT.into('oakhaven.curse.WaterReports').entries({ ID, area_ID: areaId, problem, note: note || null });
  return SELECT.one.from('WaterSupplyService.WaterReports').where({ ID });
}

/** Maren marks a report as dealt with. */
async function markHandled(req: ActionRequest): Promise<unknown> {
  await UPDATE(req.subject).with({ handled: true });
  return SELECT.one.from(req.subject);
}

/**
 * The crew marks a pipe as repaired. Three things happen together:
 * the pipe leaves today's list (repairedAt = now; it used one of the day's two repairs),
 * a line goes into the repair history (Repairs), and the open reports of the places it feeds are closed.
 */
async function markRepaired(req: ActionRequest): Promise<unknown> {
  const pipeId = typeof req.data.pipe_ID === 'string' ? req.data.pipe_ID : '';
  const pipe = pipeId ? await SELECT.one.from('oakhaven.curse.WaterPipes').where({ ID: pipeId }) : undefined;
  if (!pipe) return req.error(404, 'Deze leiding bestaat niet.', 'pipe_ID');

  const now = new Date().toISOString();
  await UPDATE('oakhaven.curse.WaterPipes', pipeId).with({ repairedAt: now });
  await INSERT.into('oakhaven.curse.Repairs').entries({
    ID: cds.utils.uuid(),
    pipe_ID: pipeId,
    repairID: cds.utils.uuid(),
    issue: 'Hersteld tijdens de ochtendronde',
    repairDate: now,
    repairedBy: 'Ploeg van Maren',
  });
  const areas = await SELECT.from('oakhaven.curse.Landmarks').columns<{ ID: string }>('ID').where({ suppliedBy: pipe.pipeID });
  if (areas.length > 0) {
    await UPDATE('oakhaven.curse.WaterReports').with({ handled: true }).where({ area_ID: { in: areas.map((a) => a.ID) }, handled: false });
  }
  return true;
}

export default class WaterSupplyService extends cds.ApplicationService {
  override async init(): Promise<void> {
    // 👋 EXAMPLE — register the handler: after every READ of WaterPipes, add daysSinceMaintenance.
    this.after('READ', 'WaterPipes', addDaysSinceMaintenance);

    // Maren's morning round: the plan for every pipe, and only today's visits.
    this.after('READ', 'MorningRound', (results) => planRound(results, ALL_PIPES));
    this.after('READ', 'TodayStops', (results) => planRound(results, TODAY));
    this.after('READ', 'LaterStops', (results) => planRound(results, LATER));

    // Reports from villagers.
    this.on('reportProblem', reportProblem);
    this.on('markHandled', 'WaterReports', markHandled);
    // The crew: a pipe is repaired.
    this.on('markRepaired', markRepaired);

    startDemoSensorFeed();
    return super.init();
  }
}
