/**
 * Maren's morning round: which pipe the water crew visits first, and why.
 *
 * Pure rules, no database: the service hands in the pipes and the landmarks, this module returns a
 * plan per pipe. Every rule below was confirmed by Maren Holt (the water keeper) in the HTF chat;
 * her words are quoted next to it.
 */

/** How bad a pipe is. */
export type PipeLevel = 'alarm' | 'attention' | 'ok';

/**
 * Which of Maren's rules put a visit before the next one (shown as the "why" sentence):
 * - peopleFirst: people get water from this pipe, the next one is a pipe nobody depends on
 * - alarmFirst:  same group, but this one is an alarm and the next one "aandacht nodig"
 * - areaOrder:   same level, other line → North Residential → The Bakery → South Meadow Farms
 * - upstream:    same level, same line → the upstream pipe goes first
 * - nobody:      the last visit, and nobody depends on it
 * - last:        the last visit (nothing else waits)
 */
export type WhyCode = 'peopleFirst' | 'alarmFirst' | 'areaOrder' | 'upstream' | 'nobody' | 'last';

/** The facts about one pipe that the rules need. */
export interface PipeFacts {
  readonly ID: string;
  readonly pipeID: string;
  readonly startPoint: string;
  readonly endPoint: string;
  readonly nominalFlowRate: number; // L/min
  readonly currentFlowRate: number; // L/min
  readonly currentPressure: number; // PSI
  /** Open (not handled) reports from villagers at a place this pipe feeds: problem codes. */
  readonly reports?: readonly string[];
}

/** The facts about one landmark that the rules need. */
export interface LandmarkFacts {
  readonly name: string;
  readonly kind: string;
  /** pipeID of the pipe that feeds this landmark, if any. */
  readonly suppliedBy: string | null;
  /** Maren's order between areas (1 = first), if she gave one. */
  readonly waterPriority: number | null;
  readonly households: number | null;
}

/** The outcome of the rules for one pipe. */
export interface PipePlan {
  readonly level: PipeLevel;
  /** Current flow as a whole percentage of the normal (nominal) flow. */
  readonly flowPercent: number;
  /** Below the flow limit of its level (alarm: 50 %, attention: 80 %). */
  readonly lowFlow: boolean;
  /** Below the pressure limit of its level (alarm: 25 PSI, attention: 40 PSI). */
  readonly lowPressure: boolean;
  /** Place in the visiting order (1 = go first); null when the pipe needs no visit. */
  readonly visitOrder: number | null;
  /** One of the visits the crew can do today. */
  readonly today: boolean;
  /** Landmarks that get their water through this pipe (directly or further downstream), best priority first. */
  readonly servedAreas: readonly string[];
  /** Households behind this pipe; null unless a villager told us the number for every area behind it. */
  readonly households: number | null;
  /** Nobody gets water through this pipe. */
  readonly nobodyDependsOnIt: boolean;
  /** The level from the measurements alone (level may be higher because of a report). */
  readonly measuredLevel: PipeLevel;
  /** The most serious open report from villagers (noWater, littleWater, leak, other), or null. */
  readonly reportedProblem: string | null;
  /** The level was raised by a villager's report, not by the measurements. */
  readonly raisedByReport: boolean;
  /** The rule that put this visit before the next one; null when the pipe needs no visit. */
  readonly whyBeforeNext: WhyCode | null;
  /** pipeIDs that run dry when this pipe fails (itself and everything downstream). */
  readonly downstreamPipes: readonly string[];
}

// "Een alarm, dus debiet onder de helft van normaal of druk onder 25 PSI"
const ALARM_FLOW_PERCENT = 50;
const ALARM_PRESSURE = 25;
// "minder dan 80 procent van het normale debiet … of als de druk onder 40 PSI zakt"
// "Het moet er wel echt onder zitten: precies 80 procent of precies 40 PSI is nog goed." → strict <
const ATTENTION_FLOW_PERCENT = 80;
const ATTENTION_PRESSURE = 40;
// "Een herstelling duurt ongeveer een halve dag, dus meer dan twee per dag lukt ons niet."
export const VISITS_PER_DAY = 2;

/** "alarm gaat altijd voor 'aandacht nodig'" */
const LEVEL_RANK: Readonly<Record<PipeLevel, number>> = { alarm: 0, attention: 1, ok: 2 };
/** Areas Maren gave no place in her order come after the ones she did. */
const UNRANKED = Number.MAX_SAFE_INTEGER;
/** Landmark kind where the water comes from: nothing flows on past it. */
const SOURCE_KIND = 'spring';

/** Flow as a percentage of normal; a pipe without a normal flow counts as 100 %. */
function flowPercentOf(pipe: PipeFacts): number {
  return pipe.nominalFlowRate > 0 ? (pipe.currentFlowRate / pipe.nominalFlowRate) * 100 : 100;
}

/**
 * Villagers' reports, read in Maren's own levels (the team owner decided the app weighs reports):
 * "geen water" is certainly less than half of normal → alarm; "weinig water" is less than normal but
 * not nothing → aandacht nodig. A leak or "iets anders" has no level of its own: shown, not ranked.
 */
const REPORT_LEVEL: Readonly<Record<string, PipeLevel>> = { noWater: 'alarm', littleWater: 'attention' };
/** Most serious first, for showing one report per pipe. */
const REPORT_ORDER = ['noWater', 'littleWater', 'leak', 'other'];

function reportLevelOf(pipe: PipeFacts): PipeLevel {
  const levels = (pipe.reports ?? []).map((code) => REPORT_LEVEL[code] ?? 'ok');
  return levels.reduce<PipeLevel>((worst, level) => (LEVEL_RANK[level] < LEVEL_RANK[worst] ? level : worst), 'ok');
}

function worstReport(pipe: PipeFacts): string | null {
  const reports = pipe.reports ?? [];
  return REPORT_ORDER.find((code) => reports.includes(code)) ?? (reports[0] ?? null);
}

/** Maren's two limits, strictly "below". */
export function levelOf(pipe: PipeFacts): PipeLevel {
  const percent = flowPercentOf(pipe);
  if (percent < ALARM_FLOW_PERCENT || pipe.currentPressure < ALARM_PRESSURE) return 'alarm';
  if (percent < ATTENTION_FLOW_PERCENT || pipe.currentPressure < ATTENTION_PRESSURE) return 'attention';
  return 'ok';
}

/**
 * The pipe network as flow direction: a pipe feeds every pipe that starts where it ends.
 * "water loopt stroomafwaarts. Valt een leiding uit, dan zit iedereen erachter ook zonder"
 * A pipe that ends at the spring (the SECONDARY-LOOP) feeds nothing: the spring is the source.
 */
class Network {
  private readonly pipes: readonly PipeFacts[];
  private readonly sources: ReadonlySet<string>;

  public constructor(pipes: readonly PipeFacts[], landmarks: readonly LandmarkFacts[]) {
    this.pipes = pipes;
    this.sources = new Set(landmarks.filter((l) => l.kind === SOURCE_KIND).map((l) => l.name));
  }

  /** Pipes that get their water straight from `pipe`. */
  private fedBy(pipe: PipeFacts): PipeFacts[] {
    if (this.sources.has(pipe.endPoint)) return [];
    return this.pipes.filter((other) => other.ID !== pipe.ID && other.startPoint === pipe.endPoint);
  }

  /** pipeIDs of `pipe` and everything downstream of it. */
  public downstreamOf(pipe: PipeFacts): Set<string> {
    const seen = new Set<string>([pipe.pipeID]);
    const queue = [pipe];
    for (let current = queue.shift(); current; current = queue.shift()) {
      for (const next of this.fedBy(current)) {
        if (!seen.has(next.pipeID)) {
          seen.add(next.pipeID);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  /** Number of pipes between the spring and `pipe` (0 = starts at the spring); upstream = smaller. */
  public depths(): Map<string, number> {
    const depth = new Map<string, number>();
    const queue = this.pipes.filter((p) => this.sources.has(p.startPoint));
    for (const pipe of queue) depth.set(pipe.pipeID, 0);
    for (let current = queue.shift(); current; current = queue.shift()) {
      for (const next of this.fedBy(current)) {
        if (!depth.has(next.pipeID)) {
          depth.set(next.pipeID, (depth.get(current.pipeID) ?? 0) + 1);
          queue.push(next);
        }
      }
    }
    return depth;
  }
}

/** Everything the ordering needs about one pipe. */
interface Candidate {
  readonly pipe: PipeFacts;
  readonly level: PipeLevel;
  readonly bestPriority: number;
  readonly depth: number;
  readonly areas: readonly LandmarkFacts[];
  readonly downstream: ReadonlySet<string>;
}

/**
 * Visiting order, Maren's rules in this sequence:
 * 1. "SECONDARY-LOOP … komt altijd als laatste, ook als ze in alarm staat … er hangt niemand van af"
 *    → pipes nobody depends on go after all pipes people get water from.
 * 2. "alarm gaat altijd voor 'aandacht nodig'"
 * 3. Same level, not on the same line → "de mensen voor: eerst North Residential Area …, dan The Bakery,
 *    dan South Meadow Farms" — for both levels. A pipe counts for every area downstream of it.
 * 4. Same level, same line → "gaat de stroomopwaartse voor, omdat die meer mensen raakt".
 *    An upstream pipe serves every area its downstream pipe serves, so it never has a worse
 *    priority; when the priorities are equal, the one closer to the spring goes first.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    Number(a.areas.length === 0) - Number(b.areas.length === 0) ||
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    a.bestPriority - b.bestPriority ||
    a.depth - b.depth ||
    a.pipe.pipeID.localeCompare(b.pipe.pipeID)
  );
}

/** The first of the rules in {@link compareCandidates} that separates `a` from the visit after it. */
function whyBefore(a: Candidate, next: Candidate | undefined): WhyCode {
  if (!next) return a.areas.length === 0 ? 'nobody' : 'last';
  if (a.areas.length > 0 && next.areas.length === 0) return 'peopleFirst';
  if (LEVEL_RANK[a.level] < LEVEL_RANK[next.level]) return 'alarmFirst';
  if (a.downstream.has(next.pipe.pipeID)) return 'upstream'; // same line
  return 'areaOrder';
}

/** Plans the morning round: one {@link PipePlan} per pipe ID. */
export function planMorningRound(
  pipes: readonly PipeFacts[],
  landmarks: readonly LandmarkFacts[],
): Map<string, PipePlan> {
  const network = new Network(pipes, landmarks);
  const depths = network.depths();

  const candidates: Candidate[] = pipes.map((pipe) => {
    const downstream = network.downstreamOf(pipe);
    const areas = landmarks
      .filter((l) => l.suppliedBy !== null && downstream.has(l.suppliedBy))
      .sort((x, y) => (x.waterPriority ?? UNRANKED) - (y.waterPriority ?? UNRANKED));
    return {
      pipe,
      level: LEVEL_RANK[reportLevelOf(pipe)] < LEVEL_RANK[levelOf(pipe)] ? reportLevelOf(pipe) : levelOf(pipe),
      bestPriority: areas[0]?.waterPriority ?? UNRANKED,
      depth: depths.get(pipe.pipeID) ?? UNRANKED,
      areas,
      downstream,
    };
  });

  // Only pipes that are not "ok" need a visit ("Dan plan ik deze week een bezoek").
  const visits = candidates.filter((c) => c.level !== 'ok').sort(compareCandidates);
  const visitOrder = new Map(visits.map((c, index) => [c.pipe.ID, index + 1]));
  const why = new Map(visits.map((c, index) => [c.pipe.ID, whyBefore(c, visits[index + 1])]));

  const plans = new Map<string, PipePlan>();
  for (const c of candidates) {
    const percent = flowPercentOf(c.pipe);
    const flowLimit = c.level === 'alarm' ? ALARM_FLOW_PERCENT : ATTENTION_FLOW_PERCENT;
    const pressureLimit = c.level === 'alarm' ? ALARM_PRESSURE : ATTENTION_PRESSURE;
    // Only a complete count is shown: 140 households is North Residential Area alone, so it must
    // not look like the total behind PRIMARY-MAIN when the bakery and the farms are unknown.
    const complete = c.areas.length > 0 && c.areas.every((a) => a.households !== null);
    const order = visitOrder.get(c.pipe.ID) ?? null;
    plans.set(c.pipe.ID, {
      level: c.level,
      flowPercent: Math.round(percent),
      lowFlow: c.level !== 'ok' && percent < flowLimit,
      lowPressure: c.level !== 'ok' && c.pipe.currentPressure < pressureLimit,
      visitOrder: order,
      today: order !== null && order <= VISITS_PER_DAY,
      servedAreas: c.areas.map((a) => a.name),
      households: complete ? c.areas.reduce((sum, a) => sum + (a.households ?? 0), 0) : null,
      nobodyDependsOnIt: c.areas.length === 0,
      measuredLevel: levelOf(c.pipe),
      reportedProblem: worstReport(c.pipe),
      raisedByReport: c.level !== levelOf(c.pipe),
      whyBeforeNext: why.get(c.pipe.ID) ?? null,
      downstreamPipes: [...c.downstream],
    });
  }
  return plans;
}
