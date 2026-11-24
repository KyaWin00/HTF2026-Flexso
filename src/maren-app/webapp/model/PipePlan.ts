/**
 * The pipe plan, drawn like a transit map (Maren: "op dezelfde lijn", "stroomopwaarts"): the spring on
 * top, every pipe a line from the place it starts to the place it ends. Used twice:
 * - crew (Main view): each line in its level (colour + dash pattern), today's stops as numbered dots,
 *   a "dry shadow" behind the pipes whose people are without water;
 * - residents (Resident view): plain lines, no planning; the places they can report from are big dots
 *   to tap ("waar werkt het water niet?").
 * A pipe that runs back to the spring (the reserve loop) ends in a small "terug naar de bron" stop.
 */

/** One pipe as the plan needs it. */
export interface PlanPipe {
  pipeID: string;
  startPoint: string;
  endPoint: string;
  /** pipeIDs downstream of this one (itself included), comma-separated. */
  downstreamPipes: string | null;
  level?: string | null;
  visitOrder?: number | null;
  nobodyDependsOnIt?: boolean | null;
}

export interface PlanOptions {
  /** Crew view: levels, numbered dots and the dry shadow. Residents: plain lines. */
  showStatus: boolean;
  /** pipeIDs to draw the dry shadow behind (crew view). */
  dry?: ReadonlySet<string>;
  /** Places a resident can tap (Landmarks with a pipe that feeds them). */
  selectablePlaces?: ReadonlySet<string>;
  /** The place the resident tapped. */
  selectedPlace?: string;
  text(key: string, args?: unknown[]): string;
  levelText?(level: string | null): string;
}

const COL = 96;
const ROW = 100;
const TOP = 34;
const SIDE = 50;

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface PlanNode {
  label: string;
  depth: number;
  x: number;
  y: number;
  back: boolean;
  children: { pipe: PlanPipe; node: PlanNode }[];
}

/** The plan as an SVG string (one root element, for core:HTML). */
export default function buildPipePlan(pipes: readonly PlanPipe[], options: PlanOptions): string {
  // The root: where the pipe with the most pipes behind it starts (the spring).
  const main = [...pipes].sort(
    (a, b) => (b.downstreamPipes ?? "").split(",").length - (a.downstreamPipes ?? "").split(",").length,
  )[0];
  if (!main) return "<div></div>";

  const seen = new Set<string>([main.startPoint]);
  const leaves: PlanNode[] = [];
  const build = (name: string, depth: number, back: boolean): PlanNode => {
    const node: PlanNode = { label: back ? options.text("planBack") : name, depth, x: 0, y: TOP + depth * ROW, back, children: [] };
    if (!back) {
      for (const pipe of pipes.filter((p) => p.startPoint === name)) {
        const loop = seen.has(pipe.endPoint);
        seen.add(pipe.endPoint);
        node.children.push({ pipe, node: build(pipe.endPoint, depth + 1, loop) });
      }
    }
    if (node.children.length === 0) leaves.push(node);
    return node;
  };
  const root = build(main.startPoint, 0, false);
  leaves.forEach((leaf, index) => (leaf.x = SIDE + index * COL));
  const position = (node: PlanNode): number => {
    if (node.children.length > 0) {
      const xs = node.children.map((child) => position(child.node));
      node.x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    return node.x;
  };
  position(root);

  const dry = options.dry ?? new Set<string>();
  const shadows: string[] = [];
  const lines: string[] = [];
  const stations: string[] = [];
  const badges: string[] = [];
  const walk = (node: PlanNode): void => {
    for (const { pipe, node: child } of node.children) {
      const midY = node.y + ROW / 2;
      const d = `M${node.x},${node.y} V${midY} H${child.x} V${child.y}`;
      const id = escapeXml(pipe.pipeID);
      if (options.showStatus) {
        const level = escapeXml(pipe.level ?? "ok");
        const title = escapeXml(options.text("mapPipeTitle", [pipe.startPoint, pipe.endPoint, options.levelText?.(pipe.level ?? null) ?? ""]));
        if (dry.has(pipe.pipeID)) shadows.push(`<path class="planDry" d="${d}"/>`);
        lines.push(`<path class="planLine planLine--${level}" data-pipe="${id}" d="${d}"><title>${title}</title></path>`);
        if (pipe.visitOrder !== null && pipe.visitOrder !== undefined) {
          const by = midY + (child.y - midY) * 0.42;
          badges.push(
            `<g class="planBadge" data-pipe="${id}"><circle cx="${child.x}" cy="${by}" r="13"/>` +
              `<text x="${child.x}" y="${by + 5}" text-anchor="middle">${pipe.visitOrder}</text></g>`,
          );
        }
      } else {
        lines.push(`<path class="planLine planLine--plain" d="${d}"/>`);
      }
      walk(child);
    }

    const end = node.children.length === 0;
    const tappable = !options.showStatus && !node.back && (options.selectablePlaces?.has(node.label) ?? false);
    const selected = tappable && options.selectedPlace === node.label;
    if (tappable) {
      // A big dot to tap with a finger (or a glove): the resident's place.
      const label = escapeXml(options.text("reportPlanPick", [node.label]));
      stations.push(
        `<g class="planPlace${selected ? " planPlace--selected" : ""}" data-place="${escapeXml(node.label)}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="${label}">` +
          `<circle class="planPlaceHit" cx="${node.x}" cy="${node.y}" r="26"/>` +
          `<circle class="planPlaceDot" cx="${node.x}" cy="${node.y}" r="15"/></g>`,
      );
    } else {
      stations.push(`<circle class="planStation" cx="${node.x}" cy="${node.y}" r="${node.back ? 5 : 8}"/>`);
    }

    // Name: right of a station that has lines below it, under an end station.
    const words = node.label.split(" ");
    const half = Math.ceil(words.length / 2);
    const nameLines = words.length > 1 && node.label.length > 12 ? [words.slice(0, half).join(" "), words.slice(half).join(" ")] : [node.label];
    const tx = end ? node.x : node.x + 14;
    const ty = end ? node.y + (tappable ? 34 : 24) : node.y + 4;
    const cls = node.back ? "planLabel planLabel--muted" : selected ? "planLabel planLabel--selected" : "planLabel";
    stations.push(
      `<text class="${cls}" x="${tx}" y="${ty}" text-anchor="${end ? "middle" : "start"}">` +
        nameLines.map((t, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : 15}">${escapeXml(t)}</tspan>`).join("") +
        `</text>`,
    );
    if (options.showStatus && end && !node.back) {
      const feeding = pipes.find((p) => p.endPoint === node.label);
      if (feeding && dry.has(feeding.pipeID) && !feeding.nobodyDependsOnIt) {
        stations.push(`<text class="planDryText" x="${tx}" y="${ty + nameLines.length * 15 + 2}" text-anchor="middle">${escapeXml(options.text("dryLabel"))}</text>`);
      }
    }
  };
  walk(root);

  const depth = Math.max(...leaves.map((leaf) => leaf.depth));
  const width = SIDE * 2 + (leaves.length - 1) * COL;
  const height = TOP + depth * ROW + 80;
  const alt = escapeXml(options.text(options.showStatus ? "planAlt" : "reportPlanAlt"));
  return (
    `<div class="marenPlan"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${alt}">` +
    shadows.join("") + lines.join("") + stations.join("") + badges.join("") +
    `</svg></div>`
  );
}
