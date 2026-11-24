/**
 * "Hoe staat Oakhaven ervoor?" — the first page of the council's Monday sheet (Rowan):
 * "vóór het voorstel wil ik op één blad zien hoe het met Oakhaven gaat, water en eten samen per deel
 *  van het dorp, met de grootste problemen bovenaan."
 *
 * Pure rules, no database. Water per area comes from Maren's limits (the worst pipe on the line
 * that feeds it), food from Tobin's limits, the warning signs from Ilse.
 *
 * Food per area is a TEAM choice (Rowan: "hoe u dat precies meet, laat ik aan u over"): the whole
 * village eats from one pantry, so every area shares the pantry's state — except The Bakery, which
 * depends on Tobin's bread ingredients (flour, milk, butter).
 */
import type { DoubtReason } from './council-rules';
import type { PipeLevel } from './morning-round';

/**
 * Food state, in Tobin's words:
 * - hunger: below HALF the comfort level before a normal delivery can arrive ("paniek")
 * - tight:  below the comfort level, or to be ordered today ("zenuwachtig")
 * - ok:     nothing to worry about this week
 */
export type FoodLevel = 'hunger' | 'tight' | 'ok';

export interface AreaInput {
  readonly name: string;
  readonly kind: string;
  readonly households: number | null;
  readonly waterLevel: PipeLevel;
  readonly worstPipe: string | null;
  readonly waterDoubts: readonly DoubtReason[];
}

export interface FoodInput {
  readonly name: string;
  readonly forBread: boolean;
  /** Tobin's panic: below half the comfort level before today's order arrives. */
  readonly panic: boolean;
  /** Below the comfort level, or to be ordered today. */
  readonly tight: boolean;
  readonly doubts: readonly DoubtReason[];
}

export interface OverviewRow {
  area: string;
  households: number | null;
  waterLevel: PipeLevel;
  /** The pipe that causes the water problem (empty when water is ok). */
  waterCause: string;
  foodLevel: FoodLevel;
  /** The products behind the food problem, comma-separated. */
  foodCause: string;
  /** Products whose number cannot be trusted (Ilse) — not judged, to be checked first. */
  foodCheck: string;
  /** All of Ilse's signs behind this row, comma-separated. */
  doubtReasons: string;
  /** 0 = red (no water now / hunger), 1 = orange, 2 = fine. */
  severity: number;
  sortOrder: number;
}

const WATER_SEVERITY: Readonly<Record<PipeLevel, number>> = { alarm: 0, attention: 1, ok: 2 };
const FOOD_SEVERITY: Readonly<Record<FoodLevel, number>> = { hunger: 0, tight: 1, ok: 2 };

function foodOf(items: readonly FoodInput[]): { level: FoodLevel; cause: string; check: string; doubts: DoubtReason[] } {
  const trusted = items.filter((item) => item.doubts.length === 0);
  const hunger = trusted.filter((item) => item.panic);
  const tight = trusted.filter((item) => !item.panic && item.tight);
  const level: FoodLevel = hunger.length > 0 ? 'hunger' : tight.length > 0 ? 'tight' : 'ok';
  const cause = (level === 'hunger' ? hunger : level === 'tight' ? tight : []).map((item) => item.name).join(', ');
  const doubtful = items.filter((item) => item.doubts.length > 0);
  return {
    level,
    cause,
    check: doubtful.map((item) => item.name).join(', '),
    doubts: doubtful.flatMap((item) => [...item.doubts]),
  };
}

/** One row per part of the village, the biggest problems on top. */
export function overviewOfVillage(areas: readonly AreaInput[], food: readonly FoodInput[]): OverviewRow[] {
  const pantry = foodOf(food);
  const bakery = foodOf(food.filter((item) => item.forBread));
  const rows = areas.map((area) => {
    const areaFood = area.kind === 'bakery' ? bakery : pantry;
    const severity = Math.min(WATER_SEVERITY[area.waterLevel], FOOD_SEVERITY[areaFood.level]);
    return {
      area: area.name,
      households: area.households,
      waterLevel: area.waterLevel,
      waterCause: area.waterLevel === 'ok' ? '' : (area.worstPipe ?? ''),
      foodLevel: areaFood.level,
      foodCause: areaFood.cause,
      foodCheck: areaFood.check,
      doubtReasons: [...new Set([...area.waterDoubts, ...areaFood.doubts])].join(','),
      severity,
      // Both red counts as worse than one red; then the most households first.
      weight: WATER_SEVERITY[area.waterLevel] + FOOD_SEVERITY[areaFood.level],
    };
  });
  rows.sort(
    (a, b) =>
      a.severity - b.severity ||
      a.weight - b.weight ||
      (b.households ?? -1) - (a.households ?? -1) ||
      a.area.localeCompare(b.area),
  );
  return rows.map(({ weight: _weight, ...row }, index) => ({ ...row, sortOrder: index + 1 }));
}
