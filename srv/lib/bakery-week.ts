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
export type DayLevel = 'ok' | 'belowComfort' | 'empty';

/** The facts of one ingredient, as stored in StockItems. `null` = not known. */
export interface IngredientFacts {
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

/** The expected stock for each morning of the outlook, without any new delivery. */
function buildOutlook(facts: IngredientFacts, quantity: number, comfortLevel: number, usePerDay: number, today: Date): OutlookDay[] {
  const days: OutlookDay[] = [];
  for (let day = 0; day < OUTLOOK_DAYS; day++) {
    const expected = Math.max(0, round2(quantity - usePerDay * day));
    let level: DayLevel = 'ok';
    if (expected <= 0) level = 'empty';
    else if (expected < comfortLevel) level = 'belowComfort';
    days.push({ day, date: addDays(today, day), quantity: expected, unit: facts.unit, level });
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
    outlook: [],
  };

  // The same rule as below, solved for the quantity: with less than this in the pantry the advice
  // is 'today'. Used to make "tel na" concrete when the stored quantity cannot be true.
  const orderBelowQuantity =
    comfortLevel !== null && usePerDay !== null && leadTimeDays !== null
      ? round2(comfortLevel + usePerDay * (leadTimeDays + MARGIN_DAYS + 1))
      : null;

  // Ilse (who checks the records): "een negatieve voorraad … kan gewoon niet waar zijn".
  // So we do not calculate with it: Tobin has to count first.
  if (quantity !== null && quantity < 0) {
    return { ...empty, advice: 'impossible', quantityTrusted: false, orderBelowQuantity };
  }

  if (quantity === null || comfortLevel === null || usePerDay === null || leadTimeDays === null) return empty;

  const belowComfortNow = quantity < comfortLevel;
  const outlook = buildOutlook(facts, quantity, comfortLevel, usePerDay, today);
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
      outlook,
    };
  }

  // Days of use left above the comfort level (negative = already below it).
  const daysAboveComfort = (quantity - comfortLevel) / usePerDay;

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

  // First morning below the comfort level: the first day d with quantity − usePerDay × d < comfort.
  const belowComfortInDays = daysAboveComfort < 0 ? 0 : Math.floor(daysAboveComfort + EPSILON) + 1;

  return {
    advice,
    quantityTrusted: true,
    daysAboveComfort: round2(daysAboveComfort),
    latestOrderInDays: advice === 'late' ? null : Math.max(0, safeOrderDay),
    latestOrderDate: advice === 'late' ? null : addDays(today, Math.max(0, safeOrderDay)),
    belowComfortNow,
    belowComfortDate: addDays(today, belowComfortInDays),
    orderBelowQuantity,
    outlook,
  };
}
