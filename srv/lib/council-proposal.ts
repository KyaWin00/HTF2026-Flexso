/**
 * The council's weekly proposal (Rowan): "als u onze 500 kronen had, gaat het hierheen, en waarom."
 *
 * Pure rules, no database: the service hands in what Maren's, Tobin's and Ilse's rules already
 * concluded per pipe and per food item; this module only decides what goes into the proposal.
 * Rowan: "Wij beslissen uiteindelijk zelf" — so it is advice, and every line carries its reason.
 */
import type { Advice } from './bakery-week';
import type { DoubtReason } from './council-rules';
import type { PipeLevel } from './morning-round';

/**
 * Why a line costs money this week. Rowan: "Het doet pijn zodra iemand in Oakhaven deze week geen
 * water heeft of honger dreigt te krijgen." How we measure that, he left to us.
 * - noWaterNow:   a pipe in alarm (Maren's limits) that people get their water through
 * - orderTooLate: even ordered today, the stock drops below HALF of Tobin's comfort level before the
 *                 delivery — Tobin: "onder de helft daarvan is het paniek" → an emergency delivery
 * - waterRisk:    a pipe that needs attention (Maren's limits) that people get their water through
 */
export type Need = 'noWaterNow' | 'orderTooLate' | 'waterRisk';

/**
 * What the proposal does with a line:
 * - proposed:       in the proposal, it fits in the budget
 * - overBudget:     would be in the proposal, but the money has run out
 * - checkFirst:     one of Ilse's signs — Rowan: "zodat we geen geld uitgeven aan een cijfer dat niet klopt"
 * - noRule:         food below its minimum, but Tobin gave us no rule for it (he decides when food is short)
 * - orderInTime:    Tobin can still order it the normal way in time: costs the council nothing extra
 * - nobodyAffected: a pipe in trouble that nobody gets water through (Maren: SECONDARY-LOOP)
 */
export type ProposalStatus = 'proposed' | 'overBudget' | 'checkFirst' | 'noRule' | 'orderInTime' | 'nobodyAffected';

/**
 * Order of needs when the money is not enough for everything. Rowan has no fixed rule and asked for
 * "waar het geld het meeste goed doet, met de uitleg waarom" — this order is the TEAM's choice:
 * who is without water now, then food that would arrive too late, then water that is at risk.
 * ⚠️ Still to be confirmed by Rowan in the chat.
 */
const NEED_RANK: Readonly<Record<Need, number>> = { noWaterNow: 0, orderTooLate: 1, waterRisk: 2 };

/** Order of the lines that are NOT proposed, in the list the council sees. */
const STATUS_RANK: Readonly<Record<ProposalStatus, number>> = {
  proposed: 0,
  overBudget: 1,
  checkFirst: 2,
  noRule: 3,
  orderInTime: 4,
  nobodyAffected: 5,
};

/** What the service knows about one pipe (Maren's rules + Ilse's signs). */
export interface WaterFacts {
  readonly pipeID: string;
  readonly level: PipeLevel;
  /** Place in Maren's visiting order (people first, upstream first, area order); null = no visit needed. */
  readonly marenOrder: number | null;
  readonly servedAreas: readonly string[];
  readonly households: number | null;
  readonly nobodyDependsOnIt: boolean;
  /** All of Ilse's signs on the pipe, its sensors and its repairs — shown to the council. */
  readonly doubts: readonly DoubtReason[];
  /** Only the signs on the numbers the money depends on (pipe + sensors) — these hold the money back. */
  readonly measurementDoubts: readonly DoubtReason[];
}

/** What the service knows about one food item (Tobin's rules + Ilse's signs). */
export interface FoodFacts {
  readonly itemID: string;
  readonly name: string;
  /** One of Tobin's bread ingredients — the only items he gave us ordering rules for. */
  readonly forBread: boolean;
  readonly advice: Advice;
  /** Tobin's panic: below half the comfort level before even today's order arrives. */
  readonly panicBeforeDelivery: boolean;
  readonly belowMinimum: boolean;
  /** Days of use left above Tobin's comfort level (lower = more urgent); null = unknown. */
  readonly daysAboveComfort: number | null;
  readonly doubts: readonly DoubtReason[];
}

/** The prices and the budget (Rowan, see council-rules.ts). */
export interface Money {
  readonly budget: number;
  readonly repairCost: number;
  readonly emergencyExtra: number;
}

/** One line of the proposal, as the council sees it. */
export interface ProposalLine {
  /** Stable key: "water-<pipeID>" or "food-<itemID>". */
  readonly ID: string;
  /** 1, 2, 3 … for proposed lines; null for the rest. */
  readonly position: number | null;
  /** Overall display order (proposed first, then the other statuses). */
  readonly sortOrder: number;
  readonly kind: 'water' | 'food';
  /** pipeID or itemID. */
  readonly ref: string;
  /** Pipe ID or product name. */
  readonly title: string;
  /** Parts of the village behind a pipe, comma-separated; empty for food (the whole village). */
  readonly areas: string;
  readonly households: number | null;
  readonly need: Need | null;
  readonly status: ProposalStatus;
  readonly cost: number;
  /** Sum of the proposal up to and including this line; null when not proposed. */
  readonly cumulative: number | null;
  /** Budget left after this line; null when not proposed. */
  readonly remaining: number | null;
  /** Ilse's signs, comma-separated ("" = none). */
  readonly doubtReasons: string;
}

/** A line before the money is divided. */
interface Candidate {
  readonly line: Omit<ProposalLine, 'position' | 'sortOrder' | 'cumulative' | 'remaining' | 'status'>;
  /** null = not a candidate; it gets `status` as it is. */
  readonly status: ProposalStatus | null;
  /** Order between two lines of the same need (lower first). */
  readonly tieBreak: number;
}

function waterCandidate(pipe: WaterFacts, money: Money): Candidate | null {
  if (pipe.level === 'ok') return null;
  const need: Need | null = pipe.nobodyDependsOnIt ? null : pipe.level === 'alarm' ? 'noWaterNow' : 'waterRisk';
  let status: ProposalStatus | null = null;
  // Only a doubtful MEASUREMENT holds the money back; a doubtful repair record stays visible as a
  // warning in doubtReasons, but the people behind the pipe still get their repair.
  if (pipe.measurementDoubts.length > 0) status = 'checkFirst';
  else if (pipe.nobodyDependsOnIt) status = 'nobodyAffected';
  return {
    line: {
      ID: `water-${pipe.pipeID}`,
      kind: 'water',
      ref: pipe.pipeID,
      title: pipe.pipeID,
      areas: pipe.servedAreas.join(', '),
      households: pipe.households,
      need,
      cost: money.repairCost,
      doubtReasons: [...new Set(pipe.doubts)].join(','),
    },
    status,
    // Maren's order already puts people first, upstream first and her area order.
    tieBreak: pipe.marenOrder ?? Number.MAX_SAFE_INTEGER,
  };
}

function foodCandidate(item: FoodFacts, money: Money): Candidate | null {
  let status: ProposalStatus | null = null;
  let need: Need | null = null;
  if (item.doubts.length > 0) status = 'checkFirst';
  else if (item.advice === 'unknown') {
    // No delivery time from Tobin for this item: we cannot say when it gets short — only shown.
    if (!item.belowMinimum) return null;
    status = 'noRule';
  } else if (item.panicBeforeDelivery) {
    // Rowan: "wanneer er te weinig eten is, dat bepaalt Tobin". Tobin: "onder mijn comfortniveau word
    // ik zenuwachtig, en onder de helft daarvan is het paniek." Panic before a normal order can
    // arrive → this is when the council pays for an emergency delivery.
    need = 'orderTooLate';
  } else if (item.advice === 'late' || item.advice === 'today' || item.advice === 'soon') {
    // Nervous, not panic: Tobin orders the normal way; costs the council nothing extra.
    status = 'orderInTime';
  } else {
    return null; // ok: nothing to do
  }
  return {
    line: {
      ID: `food-${item.itemID}`,
      kind: 'food',
      ref: item.itemID,
      title: item.name,
      areas: '',
      households: null,
      need,
      cost: money.emergencyExtra,
      doubtReasons: [...new Set(item.doubts)].join(','),
    },
    status,
    tieBreak: item.daysAboveComfort ?? Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Divides the weekly budget: the most urgent need first, and within a need the order of the
 * villager who owns it. A line that no longer fits is skipped, so a cheaper one after it can still
 * use the money that is left.
 */
export function proposeWeek(water: readonly WaterFacts[], food: readonly FoodFacts[], money: Money): ProposalLine[] {
  const all = [
    ...water.map((p) => waterCandidate(p, money)),
    ...food.map((f) => foodCandidate(f, money)),
  ].filter((c): c is Candidate => c !== null);

  const needRank = (c: Candidate): number => (c.line.need === null ? Number.MAX_SAFE_INTEGER : NEED_RANK[c.line.need]);
  const candidates = all
    .filter((c) => c.status === null)
    .sort((a, b) => needRank(a) - needRank(b) || a.tieBreak - b.tieBreak || a.line.ref.localeCompare(b.line.ref));

  const lines: Omit<ProposalLine, 'sortOrder'>[] = [];
  let spent = 0;
  let position = 0;
  for (const c of candidates) {
    if (spent + c.line.cost <= money.budget) {
      spent += c.line.cost;
      position += 1;
      lines.push({ ...c.line, status: 'proposed', position, cumulative: spent, remaining: money.budget - spent });
    } else {
      lines.push({ ...c.line, status: 'overBudget', position: null, cumulative: null, remaining: null });
    }
  }
  for (const c of all) {
    if (c.status !== null) lines.push({ ...c.line, status: c.status, position: null, cumulative: null, remaining: null });
  }

  // Array.sort is stable: within a status the lines keep the order in which they were added.
  return lines
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    .map((line, index) => ({ ...line, sortOrder: index + 1 }));
}
