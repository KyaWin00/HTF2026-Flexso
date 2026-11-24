/**
 * Tobin's bakery week: when must he order flour, milk and butter so that nothing drops below his
 * comfort level before the delivery is there? Pure functions — no CAP, no database — so the rules
 * can be read (and tested) on their own. Used by srv/food-stock-service.ts (entity BakeryWeek).
 *
 * Every rule below traces back to what Tobin said in the chat:
 *   "ik zie elke ochtend wat er vandaag in de voorraadkamer ligt, maar niet of ik volgende week nog
 *    kan bakken. En dan is het altijd net te laat om nog op tijd te bestellen."
 *
 * One stock model is used everywhere: the stock on the MORNING of day d (day 0 = today) is
 * quantity − usePerDay × d, without new deliveries. A delivery arrives on a morning.
 */

/**
 * Extra days of margin ON TOP OF the delivery time. Tobin left this to us: "Hoeveel dagen speling
 * jullie daarbovenop inbouwen… dat laat ik aan jullie".
 * We chose ONE day: he reads his messages only once a day, at 5 am ("Ik lees mijn berichten wel
 * altijd om vijf uur 's ochtends bij mijn koffie"). The order date we show is one day before the
 * last possible order day — so one missed morning is not yet a missed order.
 */
export const MARGIN_DAYS = 1;

/** How many days the outlook covers: "of ik volgende week nog kan bakken". */
export const OUTLOOK_DAYS = 7;

/**
 * How much to order. Tobin: "Ik bestel zoveel dat ik, op het moment dat de levering binnenkomt,
 * mijn comfortniveau plús een week gewoon verbruik in de voorraadkamer heb liggen."
 */
export const WEEK_OF_USE_DAYS = 7;

/** Tobin: "onder mijn comfortniveau word ik zenuwachtig, en onder de helft daarvan is het paniek." */
export const PANIC_SHARE = 0.5;

/**
 * Tobin: "zaterdag is marktdag, dan gaat er dubbel zoveel bloem, melk en brood door. De
 * gemiddelden in de gegevens gelden voor gewone dagen." consumptionRate is a normal day.
 */
export const MARKET_WEEKDAY = 6; // Saturday (Date.getUTCDay)
export const MARKET_DAY_FACTOR = 2;
export const MARKET_ITEMS: ReadonlySet<string> = new Set(['FLOUR', 'MILK', 'BREAD']);

/**
 * What Tobin should do about one ingredient, most urgent first:
 * - `impossible` — the stored quantity cannot be true (below zero), so we calculate nothing
 * - `late`       — even if he orders today, it is (or gets) below his comfort level before the delivery
 * - `today`      — order today (the order date including the margin is today, or already passed)
 * - `soon`       — order tomorrow at the latest
 * - `ok`         — nothing to do yet
 * - `unknown`    — a number we need is missing (stock, comfort level, use per day or delivery time)
 */
export type Advice = 'impossible' | 'late' | 'today' | 'soon' | 'ok' | 'unknown';

/** Expected state of an ingredient on one morning of the outlook. */
export type DayLevel = 'ok' | 'belowComfort' | 'panic' | 'empty';

/** The facts of one ingredient, as stored in StockItems. `null` = not known. */
export interface IngredientFacts {
  /** itemID (FLOUR, MILK, …) — decides whether the market day counts double. */
  itemID: string | null;
  /** currentQuantity — what is in the pantry this morning. */
  quantity: number | null;
  /** minStockLevel — Tobin's comfort level: "Als het daar zo staat, ga ik ervan uit dat het klopt". */
  comfortLevel: number | null;
  /** consumptionRate — use per day (Tobin confirmed milk: about 60 L a day). */
  usePerDay: number | null;
  /** leadTimeDays — days from ordering to delivery, as Tobin told us. */
  leadTimeDays: number | null;
  /** unit of all quantities (KG, L, …) — copied into the outlook days. */
  unit: string | null;
}

/** One morning of the outlook: day 0 = today. */
export interface OutlookDay {
  day: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Expected stock that morning if nothing new is delivered (never below 0). */
  quantity: number;
  unit: string | null;
  level: DayLevel;
  /** This day is market day: this ingredient goes twice as fast. */
  marketDay: boolean;
}

/** Everything the app shows for one ingredient. */
export interface IngredientPlan {
  advice: Advice;
  /** false when the stored quantity cannot be true (negative). */
  quantityTrusted: boolean;
  /** Days of use left above the comfort level (negative = already below). */
  daysAboveComfort: number | null;
  /** Day (from today) to order at the latest, margin included; ≤ 0 = today, null = too late/unknown. */
  latestOrderInDays: number | null;
  /** ISO date to order at the latest, margin included (today when that day has passed); null when too late. */
  latestOrderDate: string | null;
  /** The stock is already below the comfort level this morning. */
  belowComfortNow: boolean | null;
  /** ISO date of the first morning below the comfort level (same model as the outlook). */
  belowComfortDate: string | null;
  /** Below this quantity the advice is 'today' (same rule, solved for the quantity). */
  orderBelowQuantity: number | null;
  /** How much to order on the advised day: comfort level + a week of use when the delivery arrives. */
  orderQuantity: number | null;
  /** Even when ordered on the advised day, the stock drops below half the comfort level ("paniek")
   *  before the delivery is there: a case for an emergency delivery via the council. */
  panicBeforeDelivery: boolean | null;
  /** Expected stock for today and the next six mornings, without new deliveries. */
  outlook: OutlookDay[];
}

/** Rank for sorting: the most urgent ingredient first. */
export const ADVICE_RANK: Readonly<Record<Advice, number>> = {
  impossible: 0,
  late: 0,
  today: 1,
  soon: 2,
  unknown: 3,
  ok: 4,
};

// Decimals are stored with two digits; this keeps e.g. 0.9999999 from flooring to 0.
const EPSILON = 1e-9;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `today` + `days`, as an ISO date (YYYY-MM-DD). Works on UTC dates, so no daylight-saving jumps. */
export function addDays(today: Date, days: number): string {
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
  return date.toISOString().slice(0, 10);
}

/** Is day `day` (0 = today) market day for this ingredient? */
function isMarketDay(facts: IngredientFacts, today: Date, day: number): boolean {
  if (!facts.itemID || !MARKET_ITEMS.has(facts.itemID)) return false;
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day));
  return date.getUTCDay() === MARKET_WEEKDAY;
}

/**
 * Use per day for one ingredient, market days included. The stock on the MORNING of day d is
 * quantity − usedBefore(d): everything used on days 0 … d−1.
 */
interface UseModel {
  useOn(day: number): number;
  usedBefore(day: number): number;
  /** Fractional days until `amount` is used up, starting this morning (negative amount → negative). */
  daysToUse(amount: number): number;
}

function useModel(facts: IngredientFacts, usePerDay: number, today: Date): UseModel {
  const useOn = (day: number): number => usePerDay * (isMarketDay(facts, today, day) ? MARKET_DAY_FACTOR : 1);
  const usedBefore = (day: number): number => {
    let used = 0;
    for (let k = 0; k < day; k++) used += useOn(k);
    return used;
  };
  const daysToUse = (amount: number): number => {
    if (amount < 0) return amount / usePerDay;
    let remaining = amount;
    // Cap at ten years: a slow ingredient (salt) must not loop forever.
    for (let day = 0; day < 3650; day++) {
      const use = useOn(day);
      if (remaining <= use + EPSILON) return day + remaining / use;
      remaining -= use;
    }
    return 3650;
  };
  return { useOn, usedBefore, daysToUse };
}

/** The expected stock for each morning of the outlook, without any new delivery. */
function buildOutlook(facts: IngredientFacts, quantity: number, comfortLevel: number, use: UseModel, today: Date): OutlookDay[] {
  const days: OutlookDay[] = [];
  for (let day = 0; day < OUTLOOK_DAYS; day++) {
    const expected = Math.max(0, round2(quantity - use.usedBefore(day)));
    let level: DayLevel = 'ok';
    if (expected <= 0) level = 'empty';
    else if (expected < comfortLevel * PANIC_SHARE) level = 'panic';
    else if (expected < comfortLevel) level = 'belowComfort';
    days.push({
      day,
      date: addDays(today, day),
      quantity: expected,
      unit: facts.unit,
      level,
      marketDay: isMarketDay(facts, today, day),
    });
  }
  return days;
}

/** Decides what Tobin should do about one ingredient, seen from `today`. */
export function planIngredient(facts: IngredientFacts, today: Date): IngredientPlan {
  const { quantity, comfortLevel, usePerDay, leadTimeDays } = facts;
  const empty: IngredientPlan = {
    advice: 'unknown',
    quantityTrusted: true,
    daysAboveComfort: null,
    latestOrderInDays: null,
    latestOrderDate: null,
    belowComfortNow: null,
    belowComfortDate: null,
    orderBelowQuantity: null,
    orderQuantity: null,
    panicBeforeDelivery: null,
    outlook: [],
  };

  // The same rule as below, solved for the quantity: with less than this in the pantry the advice
  // is 'today'. Used to make "tel na" concrete when the stored quantity cannot be true.
  const orderBelowQuantity =
    comfortLevel !== null && usePerDay !== null && leadTimeDays !== null
      ? round2(comfortLevel + useModel(facts, usePerDay, today).usedBefore(leadTimeDays + MARGIN_DAYS + 1))
      : null;

  // Ilse (who checks the records): "een negatieve voorraad … kan gewoon niet waar zijn".
  // So we do not calculate with it: Tobin has to count first.
  if (quantity !== null && quantity < 0) {
    return { ...empty, advice: 'impossible', quantityTrusted: false, orderBelowQuantity };
  }

  if (quantity === null || comfortLevel === null || usePerDay === null || leadTimeDays === null) return empty;

  const belowComfortNow = quantity < comfortLevel;
  const use = useModel(facts, usePerDay, today);
  const outlook = buildOutlook(facts, quantity, comfortLevel, use, today);
  const todayIso = addDays(today, 0);

  // Nothing is used up: the stock never changes. At or above the comfort level that is fine;
  // below it, it stays below whatever happens — order today.
  if (usePerDay <= 0) {
    return {
      ...empty,
      advice: belowComfortNow ? 'late' : 'ok',
      belowComfortNow,
      belowComfortDate: belowComfortNow ? todayIso : null,
      orderBelowQuantity,
      orderQuantity: belowComfortNow ? round2(comfortLevel - quantity) : null,
      panicBeforeDelivery: quantity < comfortLevel * PANIC_SHARE,
      outlook,
    };
  }

  // Days of use left above the comfort level (negative = already below it). Market days count
  // double, so a Saturday in between makes this shorter.
  const daysAboveComfort = use.daysToUse(quantity - comfortLevel);

  // Tobin's rule: "dat ik op tijd bestel zodat niks onder mijn comfortniveau zakt vóór de levering
  // er is." Ordered on day X, it arrives on the morning of day X + leadTimeDays; that morning the
  // stock must still be at least the comfort level: X + leadTimeDays ≤ daysAboveComfort.
  const lastPossibleOrderDay = Math.floor(daysAboveComfort - leadTimeDays + EPSILON);
  // "speling … daarbovenop": the day we tell him to order is MARGIN_DAYS before that last day.
  const safeOrderDay = lastPossibleOrderDay - MARGIN_DAYS;

  let advice: Advice = 'ok';
  if (lastPossibleOrderDay < 0) advice = 'late'; // even ordering today is too late: order today anyway
  else if (safeOrderDay <= 0) advice = 'today'; // "ik wil het weten vóór het misgaat"
  else if (safeOrderDay === 1) advice = 'soon'; // order tomorrow at the latest

  // First morning below the comfort level: the first day d with quantity − usedBefore(d) < comfort.
  const belowComfortInDays = daysAboveComfort < 0 ? 0 : Math.floor(daysAboveComfort + EPSILON) + 1;

  // How much: ordered on the advised day, it arrives `leadTimeDays` later; at that moment the
  // pantry must hold the comfort level plus a week of use (Tobin's own rule).
  const orderDay = advice === 'late' ? 0 : Math.max(0, safeOrderDay);
  const arrivalDay = orderDay + leadTimeDays;
  const stockAtDelivery = Math.max(0, quantity - use.usedBefore(arrivalDay));
  // "een week gewoon verbruik": the week after the delivery, its market day counted double.
  const weekOfUse = use.usedBefore(arrivalDay + WEEK_OF_USE_DAYS) - use.usedBefore(arrivalDay);
  const orderQuantity = round2(Math.max(0, comfortLevel + weekOfUse - stockAtDelivery));
  // The stock only goes down until the delivery, so the morning it arrives is the lowest point.
  const panicBeforeDelivery = quantity - use.usedBefore(arrivalDay) < comfortLevel * PANIC_SHARE;

  return {
    advice,
    quantityTrusted: true,
    daysAboveComfort: round2(daysAboveComfort),
    latestOrderInDays: advice === 'late' ? null : Math.max(0, safeOrderDay),
    latestOrderDate: advice === 'late' ? null : addDays(today, Math.max(0, safeOrderDay)),
    belowComfortNow,
    belowComfortDate: addDays(today, belowComfortInDays),
    orderBelowQuantity,
    orderQuantity,
    panicBeforeDelivery,
    outlook,
  };
}
