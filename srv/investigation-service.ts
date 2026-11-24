/**
 * Handlers of `InvestigationService` (see `investigation-service.cds`): Ilse's investigation.
 *
 * SuspiciousRecords, Timeline and Bursts have no table. On every read this file loads all village
 * records (water, stock, places), applies Ilse's signs (srv/lib/record-doubt.ts) and returns the
 * result — so the list always matches the data as it is now.
 *
 * `@sap/cds` ships no TypeScript declarations in this project, so it is loaded with `require`
 * and the part of its API this file uses is described in the small interfaces below.
 */
import { changeSigns, contradicts, isFuture, stampSigns, unique, type Sign, type Stamp } from './lib/record-doubt';

/** The slice of a CAP request the handlers use. */
interface CdsRequest {
  readonly data: Readonly<Record<string, unknown>>;
  readonly query?: { readonly SELECT?: { readonly where?: readonly unknown[] } };
  error(code: number, message: string, target?: string): void;
}

interface CdsService {
  init(): Promise<void>;
  on(event: string, handler: (req: CdsRequest) => unknown): void;
  on(event: string, entity: string, handler: (req: CdsRequest) => unknown): void;
}

interface SelectQuery<T> extends PromiseLike<T[]> {
  where(predicate: Readonly<Record<string, unknown>>): PromiseLike<T[]>;
}

interface CdsApi {
  readonly ApplicationService: new (...args: readonly never[]) => CdsService;
  readonly ql: {
    readonly SELECT: {
      from(entity: string): { columns<T>(...columns: readonly string[]): SelectQuery<T> };
      readonly one: {
        from(entity: string): { where(predicate: Readonly<Record<string, unknown>>): PromiseLike<Readonly<Record<string, unknown>> | undefined> };
      };
    };
    readonly INSERT: { into(entity: string): { entries(row: Readonly<Record<string, unknown>>): PromiseLike<unknown> } };
    readonly UPDATE: (entity: string) => {
      with(changes: Readonly<Record<string, unknown>>): { where(predicate: Readonly<Record<string, unknown>>): PromiseLike<number> };
    };
  };
  readonly utils: { uuid(): string };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds') as CdsApi;
const { SELECT, INSERT, UPDATE } = cds.ql;

// ---------------------------------------------------------------------------------------------
// The village records, read once per request
// ---------------------------------------------------------------------------------------------

interface StampRow {
  ID: string;
  createdBy: string | null;
  createdAt: string | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
}
type Num = number | string | null;
interface PipeRow extends StampRow { pipeID: string; startPoint: string | null; endPoint: string | null; nominalFlowRate: Num; currentFlowRate: Num; currentPressure: Num }
interface SensorRow extends StampRow { pipe_ID: string | null; sensorID: string; flowRate: Num; pressure: Num }
interface RepairRow extends StampRow { pipe_ID: string | null; issue: string | null; repairDate: string | null; repairedBy: string | null }
interface LandmarkRow extends StampRow { name: string | null }
interface StockRow extends StampRow { name: string | null; unit: string | null; currentQuantity: Num; minStockLevel: Num; consumptionRate: Num }
interface ReceivalRow extends StampRow { quantityReceived: Num; supplier: string | null; receivedAt: string | null }
interface NotificationRow extends StampRow { message: string | null }
interface MarkRow { recordType: string; recordId: string }

/** One record of the village, with the signs in its VALUES (the signs in who/when come from its stamp). */
interface VillageRecord {
  readonly type: string;
  readonly id: string;
  readonly category: 'water' | 'stock' | 'village';
  readonly label: string;
  readonly value: string;
  readonly stamp: Stamp;
  readonly valueSigns: Sign[];
  readonly contradiction: string | null;
  /** When the value signs appeared. For a contradiction: the later change of the two records —
   *  the one that caused it (never blame the record that was fine when it was written). */
  readonly valueSignsAt?: string | null;
}

const STAMP = ['ID', 'createdBy', 'createdAt', 'modifiedBy', 'modifiedAt'];
/** Record types Ilse can mark (the ones read below). */
const RECORD_TYPES: ReadonlySet<string> = new Set(['WaterPipes', 'Sensors', 'Repairs', 'Landmarks', 'StockItems', 'StockReceivals', 'Notifications']);

function num(value: Num): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stampOf(row: StampRow): Stamp {
  return { createdBy: row.createdBy, createdAt: row.createdAt, modifiedBy: row.modifiedBy, modifiedAt: row.modifiedAt };
}

/** All records of the village with the signs in their values (negative, future, too high, contradiction). */
async function readVillage(now: Date): Promise<VillageRecord[]> {
  const [pipes, sensors, repairs, landmarks, stock, receivals, notifications] = await Promise.all([
    SELECT.from('oakhaven.curse.WaterPipes').columns<PipeRow>(...STAMP, 'pipeID', 'startPoint', 'endPoint', 'nominalFlowRate', 'currentFlowRate', 'currentPressure'),
    SELECT.from('oakhaven.curse.Sensors').columns<SensorRow>(...STAMP, 'pipe_ID', 'sensorID', 'flowRate', 'pressure'),
    SELECT.from('oakhaven.curse.Repairs').columns<RepairRow>(...STAMP, 'pipe_ID', 'issue', 'repairDate', 'repairedBy'),
    SELECT.from('oakhaven.curse.Landmarks').columns<LandmarkRow>(...STAMP, 'name'),
    SELECT.from('oakhaven.curse.StockItems').columns<StockRow>(...STAMP, 'name', 'unit', 'currentQuantity', 'minStockLevel', 'consumptionRate'),
    SELECT.from('oakhaven.curse.StockReceivals').columns<ReceivalRow>(...STAMP, 'quantityReceived', 'supplier', 'receivedAt'),
    SELECT.from('oakhaven.curse.Notifications').columns<NotificationRow>(...STAMP, 'message'),
  ]);
  const pipeById = new Map(pipes.map((p) => [p.ID, p]));
  const records: VillageRecord[] = [];

  // "Twee bronnen die hetzelfde zouden moeten zeggen": a pipe and its own meter.
  const pipeContradictions = new Map<string, string[]>();
  const latest = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);
  const changedAt = (row: StampRow): string | null => row.modifiedAt ?? row.createdAt;
  const contradictionAt = new Map<string, string | null>();
  for (const s of sensors) {
    const pipe = pipeById.get(s.pipe_ID ?? '');
    const signs: Sign[] = [];
    const notes: string[] = [];
    if (pipe) {
      if (num(pipe.nominalFlowRate) > 0 && num(s.flowRate) > num(pipe.nominalFlowRate)) {
        signs.push('tooHigh');
        notes.push(`meter ${s.sensorID} meet ${num(s.flowRate)} L/min, de leiding kan maar ${num(pipe.nominalFlowRate)} L/min dragen`);
      }
      if (contradicts(num(s.flowRate), num(pipe.currentFlowRate))) {
        signs.push('contradiction');
        notes.push(`meter ${s.sensorID} zegt ${num(s.flowRate)} L/min, leiding ${pipe.pipeID} zegt ${num(pipe.currentFlowRate)} L/min`);
      }
      if (contradicts(num(s.pressure), num(pipe.currentPressure))) {
        signs.push('contradiction');
        notes.push(`meter ${s.sensorID} zegt ${num(s.pressure)} PSI, leiding ${pipe.pipeID} zegt ${num(pipe.currentPressure)} PSI`);
      }
      if (signs.includes('contradiction')) {
        pipeContradictions.set(pipe.ID, [...(pipeContradictions.get(pipe.ID) ?? []), ...notes.filter((n) => n.includes('zegt'))]);
        contradictionAt.set(pipe.ID, latest(contradictionAt.get(pipe.ID) ?? null, latest(changedAt(s), changedAt(pipe))));
      }
    }
    records.push({
      type: 'Sensors', id: s.ID, category: 'water',
      label: `Meter ${s.sensorID}${pipe ? ` op leiding ${pipe.pipeID}` : ''}`,
      value: `${num(s.flowRate)} L/min · ${num(s.pressure)} PSI`,
      stamp: stampOf(s), valueSigns: unique(signs), contradiction: notes.length > 0 ? notes.join('; ') : null,
      valueSignsAt: pipe && signs.includes('contradiction') ? latest(changedAt(s), changedAt(pipe)) : changedAt(s),
    });
  }
  for (const p of pipes) {
    const notes = pipeContradictions.get(p.ID) ?? [];
    records.push({
      type: 'WaterPipes', id: p.ID, category: 'water',
      label: `Leiding ${p.pipeID} (${p.startPoint ?? '?'} → ${p.endPoint ?? '?'})`,
      value: `${num(p.currentFlowRate)} van ${num(p.nominalFlowRate)} L/min · ${num(p.currentPressure)} PSI`,
      stamp: stampOf(p), valueSigns: notes.length > 0 ? ['contradiction'] : [], contradiction: notes.length > 0 ? notes.join('; ') : null,
      valueSignsAt: contradictionAt.get(p.ID) ?? changedAt(p),
    });
  }
  for (const r of repairs) {
    const pipe = pipeById.get(r.pipe_ID ?? '');
    records.push({
      type: 'Repairs', id: r.ID, category: 'water',
      label: `Herstelling aan ${pipe?.pipeID ?? 'een leiding'}: ${r.issue ?? ''}`.trim(),
      value: `${(r.repairDate ?? '').slice(0, 10)} · door ${r.repairedBy ?? '?'}`,
      stamp: stampOf(r), valueSigns: isFuture(r.repairDate, now) ? ['futureDate'] : [], contradiction: null,
    });
  }
  for (const l of landmarks) {
    records.push({
      type: 'Landmarks', id: l.ID, category: 'village', label: `Plek ${l.name ?? '?'}`, value: '',
      stamp: stampOf(l), valueSigns: [], contradiction: null,
    });
  }
  for (const s of stock) {
    // "een negatieve voorraad … kan gewoon niet waar zijn"
    const negative = [s.currentQuantity, s.minStockLevel, s.consumptionRate].some((v) => num(v) < 0);
    records.push({
      type: 'StockItems', id: s.ID, category: 'stock', label: `Voorraad ${s.name ?? '?'}`,
      value: `${num(s.currentQuantity)} ${s.unit ?? ''}`.trim(),
      stamp: stampOf(s), valueSigns: negative ? ['negative'] : [], contradiction: null,
    });
  }
  for (const r of receivals) {
    const signs: Sign[] = [];
    if (num(r.quantityReceived) < 0) signs.push('negative');
    if (isFuture(r.receivedAt, now)) signs.push('futureDate');
    records.push({
      type: 'StockReceivals', id: r.ID, category: 'stock', label: `Levering van ${r.supplier ?? '?'}`,
      value: `${num(r.quantityReceived)} · ${(r.receivedAt ?? '').slice(0, 10)}`,
      stamp: stampOf(r), valueSigns: signs, contradiction: null,
    });
  }
  for (const n of notifications) {
    records.push({
      type: 'Notifications', id: n.ID, category: 'stock', label: `Bericht: ${n.message ?? ''}`, value: '',
      stamp: stampOf(n), valueSigns: [], contradiction: null,
    });
  }
  return records;
}

async function activeMarks(): Promise<Set<string>> {
  const marks = await SELECT.from('oakhaven.curse.TrustMarks').columns<MarkRow>('recordType', 'recordId').where({ active: true });
  return new Set(marks.map((m) => `${m.recordType}:${m.recordId}`));
}

// ---------------------------------------------------------------------------------------------
// Computed entities
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Applies the simple filters UI5 sends ($filter=field eq value [and …]) to computed rows.
 * Anything more complex is ignored (the rows come back unfiltered).
 */
function applyWhere(rows: Row[], where: readonly unknown[] | undefined): Row[] {
  if (!where || where.length === 0) return rows;
  const tokens = where.length === 1 && isXpr(where[0]) ? where[0].xpr : where;
  const conditions: { field: string; op: string; value: unknown }[] = [];
  for (let i = 0; i + 2 < tokens.length + 1; i += 4) {
    const [ref, op, val] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (!isRef(ref) || typeof op !== 'string' || !isVal(val)) return rows;
    conditions.push({ field: ref.ref[ref.ref.length - 1], op, value: val.val });
    if (i + 3 < tokens.length && tokens[i + 3] !== 'and') return rows;
  }
  return rows.filter((row) =>
    conditions.every((c) => (c.op === '!=' || c.op === '<>' ? row[c.field] !== c.value : row[c.field] === c.value)),
  );
}
function isRef(t: unknown): t is { ref: string[] } {
  return typeof t === 'object' && t !== null && Array.isArray((t as { ref?: unknown }).ref);
}
function isVal(t: unknown): t is { val: unknown } {
  return typeof t === 'object' && t !== null && 'val' in t;
}
function isXpr(t: unknown): t is { xpr: unknown[] } {
  return typeof t === 'object' && t !== null && Array.isArray((t as { xpr?: unknown }).xpr);
}

/** "één teken is al genoeg" — every record with at least one sign; most signs first, then newest. */
async function readSuspicious(req: CdsRequest): Promise<Row[]> {
  const now = new Date();
  const [records, marks] = await Promise.all([readVillage(now), activeMarks()]);
  const rows = records
    .map((r) => ({ r, signs: unique([...stampSigns(r.stamp, now), ...r.valueSigns]) }))
    .filter(({ signs }) => signs.length > 0)
    .map(({ r, signs }) => ({
      ID: `${r.type}:${r.id}`,
      recordType: r.type,
      recordId: r.id,
      category: r.category,
      label: r.label,
      value: r.value,
      changedAt: r.stamp.modifiedAt ?? r.stamp.createdAt,
      changedBy: r.stamp.modifiedBy ?? r.stamp.createdBy,
      createdAt: r.stamp.createdAt,
      createdBy: r.stamp.createdBy,
      reasons: signs.join(','),
      reasonCount: signs.length,
      contradiction: r.contradiction,
      marked: marks.has(`${r.type}:${r.id}`),
    }))
    .sort((a, b) => b.reasonCount - a.reasonCount || String(b.changedAt).localeCompare(String(a.changedAt)));
  return applyWhere(rows, req.query?.SELECT?.where);
}

interface TimelineRow extends Row {
  ID: string; at: string; day: string; hour: number; changedBy: string | null; action: 'created' | 'modified';
  recordType: string; recordId: string; label: string; category: string;
  suspicious: boolean; night: boolean; nonHuman: boolean; noName: boolean; reasons: string;
}

/** Every change (created, last changed) of every record. The change that set a record's current
 *  value also carries that value's signs (a negative stock, a meter that contradicts its pipe…). */
async function buildTimeline(now: Date): Promise<TimelineRow[]> {
  const records = await readVillage(now);
  const rows: TimelineRow[] = [];
  for (const r of records) {
    const changes: { action: 'created' | 'modified'; by: string | null; at: string | null }[] = [
      { action: 'created', by: r.stamp.createdBy, at: r.stamp.createdAt },
    ];
    if (r.stamp.modifiedAt && r.stamp.modifiedAt !== r.stamp.createdAt) {
      changes.push({ action: 'modified', by: r.stamp.modifiedBy, at: r.stamp.modifiedAt });
    }
    // The value signs (negative, future, contradiction…) belong to the change that set the value:
    // the record's last change — unless they appeared later, through ANOTHER record (a contradiction).
    const valueAt = r.valueSignsAt ?? r.stamp.modifiedAt ?? r.stamp.createdAt;
    changes.forEach((change, index) => {
      if (!change.at) return;
      const last = index === changes.length - 1;
      const owns = last && (!valueAt || change.at >= valueAt);
      const signs = unique([...changeSigns(change.by, change.at, now), ...(owns ? r.valueSigns : [])]);
      const at = new Date(change.at);
      rows.push({
        ID: `${r.type}:${r.id}:${change.action}`,
        at: change.at,
        day: change.at.slice(0, 10),
        hour: Math.round((at.getUTCHours() + at.getUTCMinutes() / 60) * 100) / 100,
        changedBy: change.by,
        action: change.action,
        recordType: r.type,
        recordId: r.id,
        label: r.label,
        category: r.category,
        suspicious: signs.length > 0,
        night: signs.includes('night'),
        nonHuman: signs.includes('nonHuman'),
        noName: signs.includes('noName'),
        reasons: signs.join(','),
      });
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

async function readTimeline(req: CdsRequest): Promise<Row[]> {
  return applyWhere(await buildTimeline(new Date()), req.query?.SELECT?.where);
}

/** "in één keer of beetje bij beetje": suspicious changes by the same name within the same minute. */
async function readBursts(): Promise<Row[]> {
  const suspicious = (await buildTimeline(new Date())).filter((row) => row.suspicious);
  const groups = new Map<string, TimelineRow[]>();
  for (const row of suspicious) {
    const key = `${row.changedBy ?? ''}|${row.at.slice(0, 16)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .map(([key, rows]) => ({
      ID: key,
      at: rows[rows.length - 1].at,
      changedBy: rows[0].changedBy,
      count: rows.length,
      labels: rows.map((r) => r.label).join('; '),
      night: rows.some((r) => r.night),
      nonHuman: rows.some((r) => r.nonHuman),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------------------------
// Ilse's marks
// ---------------------------------------------------------------------------------------------

/** "zo'n regel kunnen markeren als 'niet te vertrouwen', zodat Maren, Tobin en de raad er niet op handelen" */
async function markUntrusted(req: CdsRequest): Promise<unknown> {
  const recordType = typeof req.data.recordType === 'string' ? req.data.recordType : '';
  const recordId = typeof req.data.recordId === 'string' ? req.data.recordId : '';
  const label = typeof req.data.label === 'string' ? req.data.label.slice(0, 200) : '';
  const note = typeof req.data.note === 'string' ? req.data.note.trim() : '';
  if (!RECORD_TYPES.has(recordType)) return req.error(400, 'Dit soort gegeven kan niet gemarkeerd worden.', 'recordType');
  if (!recordId) return req.error(400, 'Kies het gegeven dat je wilt markeren.', 'recordId');
  if (note.length > 500) return req.error(400, 'De opmerking is te lang (max. 500 tekens).', 'note');

  const existing = await SELECT.one.from('oakhaven.curse.TrustMarks').where({ recordType, recordId, active: true });
  const ID = typeof existing?.ID === 'string' ? existing.ID : cds.utils.uuid();
  if (!existing) {
    await INSERT.into('oakhaven.curse.TrustMarks').entries({ ID, recordType, recordId, recordLabel: label, note: note || null, active: true });
  }
  return SELECT.one.from('InvestigationService.TrustMarks').where({ ID });
}

/** Ilse lifts her mark. Team choice: only Ilse does this, and only on purpose — a mark never
 *  disappears by itself; it stays as history (active = false, clearedAt). */
async function clearMark(req: CdsRequest): Promise<unknown> {
  const recordType = typeof req.data.recordType === 'string' ? req.data.recordType : '';
  const recordId = typeof req.data.recordId === 'string' ? req.data.recordId : '';
  if (!recordType || !recordId) return req.error(400, 'Kies het gegeven waarvan je de markering wilt opheffen.', 'recordId');
  await UPDATE('oakhaven.curse.TrustMarks').with({ active: false, clearedAt: new Date().toISOString() }).where({ recordType, recordId, active: true });
  return true;
}

export default class InvestigationService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('READ', 'SuspiciousRecords', readSuspicious);
    this.on('READ', 'Timeline', readTimeline);
    this.on('READ', 'Bursts', readBursts);
    this.on('markUntrusted', markUntrusted);
    this.on('clearMark', clearMark);
    return super.init();
  }
}
