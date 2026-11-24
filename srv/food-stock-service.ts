/**
 * Handlers of `FoodStockService` (see `food-stock-service.cds`).
 *
 * StockItems, StockReceivals and Notifications are served by CAP's generic provider — no code.
 * BakeryWeek (Tobin's app) gets its computed fields here: see planBakeryWeek.
 *
 * `@sap/cds` ships no TypeScript declarations in this project, so it is loaded with `require`
 * and the part of its API this file uses is described in the small interfaces below.
 */
import { ADVICE_RANK, planIngredient, type Advice, type IngredientPlan } from './lib/bakery-week';

/** The request of the bound action recordDelivery: parameters in `data`, the item in `subject`. */
interface ActionRequest {
  readonly data: { quantity?: unknown; supplier?: unknown; receivedAt?: unknown };
  readonly subject: unknown;
  error(code: number, message: string, target?: string): void;
}

/** What recordDelivery returns (type DeliveryResult in food-stock-service.cds). */
interface DeliveryResult {
  stockUpdated: boolean;
  newQuantity: number | null;
}

/** The stock row recordDelivery reads. */
interface StockRow {
  ID: string;
  currentQuantity: number | string | null;
}

/** The slice of a CAP service this file uses. */
interface CdsService {
  init(): Promise<void>;
  after(event: string, entity: string, handler: (results: unknown) => unknown): void;
  on(event: string, entity: string, handler: (req: ActionRequest) => unknown): void;
}

/** A CQL SELECT with its columns set, narrowed down with `where`. */
interface SelectQuery<T> {
  where(predicate: Readonly<Record<string, unknown>>): PromiseLike<T[]>;
}

/** The slice of the `cds` facade this file uses. */
interface CdsApi {
  readonly ApplicationService: new (...args: readonly never[]) => CdsService;
  readonly ql: {
    readonly SELECT: {
      from(entity: string): {
        columns<T>(...columns: readonly string[]): SelectQuery<T>;
      };
      readonly one: {
        from(entity: unknown): { columns<T>(...columns: readonly string[]): PromiseLike<T | undefined> };
      };
    };
    readonly INSERT: {
      into(entity: string): { entries(data: Readonly<Record<string, unknown>>): PromiseLike<unknown> };
    };
    UPDATE(entity: string, key: string): { with(data: Readonly<Record<string, unknown>>): PromiseLike<unknown> };
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds') as CdsApi;
const { SELECT, INSERT, UPDATE } = cds.ql;

/** The inputs of the bakery rules, as the database returns them (Decimals arrive as strings). */
interface IngredientDbRow {
  ID: string;
  currentQuantity: number | string | null;
  minStockLevel: number | string | null;
  consumptionRate: number | string | null;
  leadTimeDays: number | null;
  unit: string | null;
  itemID: string | null;
}

/** A BakeryWeek row as the client sees it. Every field is optional: the client decides ($select). */
interface BakeryWeekRow {
  ID?: string;
  name?: string | null;
  advice?: Advice | null;
  latestOrderInDays?: number | null;
}

/** The input fields of the rules: when one is missing from a row, it is read from the database. */
const INPUT_FIELDS = ['currentQuantity', 'minStockLevel', 'consumptionRate', 'leadTimeDays'] as const;
const ALL_INPUTS = [...INPUT_FIELDS, 'unit', 'itemID'] as const;

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The unit of a row: from the row itself, else from the database. */
function unitOf(row: Record<string, unknown>, db: IngredientDbRow | undefined): string | null {
  const unit = 'unit' in row ? row.unit : db?.unit;
  return typeof unit === 'string' ? unit : null;
}

/** The virtual fields of BakeryWeek for one plan. */
function toBakeryFields(plan: IngredientPlan): Record<string, unknown> {
  return {
    advice: plan.advice,
    quantityTrusted: plan.quantityTrusted,
    daysAboveComfort: plan.daysAboveComfort,
    latestOrderInDays: plan.latestOrderInDays,
    latestOrderDate: plan.latestOrderDate,
    belowComfortNow: plan.belowComfortNow,
    belowComfortDate: plan.belowComfortDate,
    orderBelowQuantity: plan.orderBelowQuantity,
    orderQuantity: plan.orderQuantity,
    panicBeforeDelivery: plan.panicBeforeDelivery,
    outlook: plan.outlook,
  };
}

/** Most urgent first; within the same urgency, the earliest order day, then by name. */
function byUrgency(a: BakeryWeekRow, b: BakeryWeekRow): number {
  const rankA = ADVICE_RANK[a.advice ?? 'unknown'];
  const rankB = ADVICE_RANK[b.advice ?? 'unknown'];
  const dayA = a.latestOrderInDays ?? Number.MAX_SAFE_INTEGER;
  const dayB = b.latestOrderInDays ?? Number.MAX_SAFE_INTEGER;
  return rankA - rankB || dayA - dayB || (a.name ?? '').localeCompare(b.name ?? '');
}

/**
 * Fills in the advice of every bread ingredient read from BakeryWeek and sorts the result.
 * The inputs are read from the database in ONE query (UI5 only $selects the fields it binds).
 * Sorting happens here because the urgency is computed, not stored: there are only three bread
 * ingredients, so the whole list always fits in one page.
 */
async function planBakeryWeek(results: unknown): Promise<void> {
  const rows = (Array.isArray(results) ? results : [results]).filter(
    (row): row is BakeryWeekRow & Record<string, unknown> => row !== null && typeof row === 'object',
  );
  if (rows.length === 0) return;

  const missingIds = rows
    .filter((row) => ALL_INPUTS.some((field) => !(field in row)) && row.ID)
    .map((row) => row.ID);
  const dbById = new Map<string, IngredientDbRow>();
  if (missingIds.length > 0) {
    const items = await SELECT.from('oakhaven.curse.StockItems')
      .columns<IngredientDbRow>('ID', ...ALL_INPUTS)
      .where({ ID: { in: missingIds } });
    for (const item of items) dbById.set(item.ID, item);
  }

  const today = new Date();
  for (const row of rows) {
    const db = dbById.get(row.ID ?? '');
    const input = (field: (typeof INPUT_FIELDS)[number]): number | null =>
      toNumberOrNull(field in row ? row[field] : db?.[field]);
    const itemID = 'itemID' in row ? row.itemID : db?.itemID;
    const plan = planIngredient(
      {
        itemID: typeof itemID === 'string' ? itemID : null,
        quantity: input('currentQuantity'),
        comfortLevel: input('minStockLevel'),
        usePerDay: input('consumptionRate'),
        leadTimeDays: input('leadTimeDays'),
        unit: unitOf(row, db),
      },
      today,
    );
    Object.assign(row, toBakeryFields(plan));
  }

  if (Array.isArray(results)) {
    const ordered = [...rows].sort(byUrgency);
    results.splice(0, results.length, ...ordered);
  }
}

/**
 * Who notes deliveries. The app src/tobin-delivery is Tobin's alone, and there is no login in
 * this hackathon app — so we write his name, not "anonymous": Ilse wants to see a real person
 * behind every change ("system is geen mens van vlees en bloed").
 */
const DELIVERY_AUTHOR = 'tobin.reyes';

/** A few minutes of clock difference between the laptop and the server is not "the future". */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Tobin notes a delivery: "welk product, hoeveel, van wie en wanneer".
 * 1. Checks the input (a delivery in the future cannot be true — one of Ilse's signs).
 * 2. Adds a StockReceivals row.
 * 3. Raises the stock — unless the stock is negative: "die boter met min drie is een ander
 *    verhaal … vraag het Ilse". Adding to an impossible number would hide it, so we leave it.
 */
async function recordDelivery(req: ActionRequest): Promise<DeliveryResult | undefined> {
  const quantity = Number(req.data.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    req.error(400, 'Vul in hoeveel er geleverd is: een getal groter dan 0.', 'quantity');
    return undefined;
  }
  const supplier = typeof req.data.supplier === 'string' ? req.data.supplier.trim() : '';
  if (!supplier) {
    req.error(400, 'Vul in van wie de levering komt.', 'supplier');
    return undefined;
  }
  const receivedAt = typeof req.data.receivedAt === 'string' ? new Date(req.data.receivedAt) : new Date(NaN);
  if (Number.isNaN(receivedAt.getTime())) {
    req.error(400, 'Vul in wanneer de levering binnenkwam.', 'receivedAt');
    return undefined;
  }
  if (receivedAt.getTime() > Date.now() + CLOCK_TOLERANCE_MS) {
    req.error(400, 'Een levering kan niet in de toekomst binnenkomen. Kijk de datum en het uur na.', 'receivedAt');
    return undefined;
  }

  const item = await SELECT.one.from(req.subject).columns<StockRow>('ID', 'currentQuantity');
  if (!item) {
    req.error(404, 'Dit product bestaat niet (meer).');
    return undefined;
  }

  await INSERT.into('oakhaven.curse.StockReceivals').entries({
    item_ID: item.ID,
    quantityReceived: quantity,
    supplier,
    receivedAt: receivedAt.toISOString(),
    createdBy: DELIVERY_AUTHOR,
    modifiedBy: DELIVERY_AUTHOR,
  });

  const current = Number(item.currentQuantity);
  if (!Number.isFinite(current) || current < 0) {
    return { stockUpdated: false, newQuantity: Number.isFinite(current) ? current : null };
  }
  const newQuantity = Math.round((current + quantity) * 100) / 100;
  await UPDATE('oakhaven.curse.StockItems', item.ID).with({ currentQuantity: newQuantity, modifiedBy: DELIVERY_AUTHOR });
  return { stockUpdated: true, newQuantity };
}

export default class FoodStockService extends cds.ApplicationService {
  override async init(): Promise<void> {
    // Tobin's bakery week: when to order flour, milk and butter (rules in srv/lib/bakery-week.ts).
    this.after('READ', 'BakeryWeek', planBakeryWeek);
    // Tobin notes deliveries himself (app src/tobin-delivery).
    this.on('recordDelivery', 'StockItems', recordDelivery);
    return super.init();
  }
}
