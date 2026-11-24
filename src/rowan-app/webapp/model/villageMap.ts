/**
 * The council's village map: the painted map of Oakhaven with every pipe and every part of the
 * village coloured by how it is doing — Rowan: "in één oogopslag zien hoe Oakhaven ervoor staat en
 * waar het pijn doet". Used on the page (CSS classes, theme colours) and on the print sheet (plain
 * colours, the print window has no theme).
 *
 * Grid: the map is 2048 × 1536 px and an 8 × 8 grid; x/y in grid units from the south-west corner
 * of A1 (README "The village map"). Status is never colour alone: every area carries its words.
 *
 * @namespace oakhaven.rowan.model
 */

export interface MapPipe {
  pipeID?: string;
  mapPath?: string;
  /** alarm | attention | ok (Maren). */
  waterLevel?: string;
}

export interface MapArea {
  area?: string;
  gridCell?: string | null;
  /** 0 red, 1 orange, 2 fine. */
  severity?: number;
  /** "Geen water · Honger dreigt" — the status in words. */
  label: string;
}

const WIDTH = 2048;
const HEIGHT = 1536;
const GRID = 8;

/** Plain colours for paper (the print window has no SAP theme). */
const PRINT_COLOURS: Readonly<Record<string, string>> = {
  alarm: "#c62828",
  attention: "#ef8f00",
  ok: "#2e7d32",
  sev0: "#c62828",
  sev1: "#ef8f00",
  sev2: "#2e7d32",
};

function esc(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toPx(x: number, y: number): string {
  return `${Math.round((x / GRID) * WIDTH)},${Math.round(((GRID - y) / GRID) * HEIGHT)}`;
}

/** "C6" → centre of that cell in grid units. */
function cellCentre(cell: string | null | undefined): [number, number] | null {
  const match = /^([A-H])([1-8])$/.exec(cell ?? "");
  if (!match) return null;
  return [match[1].charCodeAt(0) - 65 + 0.5, Number(match[2]) - 0.5];
}

/**
 * The map as one SVG element. `print` switches from theme classes to fixed colours.
 * Problem pipes are drawn last (on top) and thicker.
 */
export function villageMapSvg(
  imageUrl: string,
  pipes: readonly MapPipe[],
  areas: readonly MapArea[],
  title: string,
  print = false,
): string {
  const ordered = [...pipes].sort((a, b) => Number(a.waterLevel !== "ok") - Number(b.waterLevel !== "ok"));
  const pipeSvg = ordered
    .map((pipe) => {
      const points = (pipe.mapPath ?? "")
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(",").map(Number))
        .filter((xy) => xy.length === 2 && xy.every(Number.isFinite))
        .map(([x, y]) => toPx(x, y))
        .join(" ");
      if (!points) return "";
      const level = pipe.waterLevel ?? "ok";
      const width = level === "ok" ? 14 : 26;
      const stroke = print ? ` stroke="${PRINT_COLOURS[level] ?? "#555"}"` : "";
      return `<polyline points="${points}" class="rowanMapCasing" stroke-width="${width + 12}" fill="none"${print ? ' stroke="#000"' : ""}/>` +
        `<polyline points="${points}" class="rowanMapPipe rowanMapPipe-${esc(level)}" stroke-width="${width}" fill="none"${stroke}><title>${esc(pipe.pipeID)}</title></polyline>`;
    })
    .join("");

  const areaSvg = areas
    .map((area) => {
      const centre = cellCentre(area.gridCell);
      if (!centre) return "";
      const [x, y] = toPx(centre[0], centre[1]).split(",").map(Number);
      const severity = `sev${area.severity ?? 2}`;
      const fill = print ? ` fill="${PRINT_COLOURS[severity]}" stroke="#fff"` : "";
      // Label above the dot, kept inside the map horizontally.
      const anchor = x < 400 ? "start" : x > WIDTH - 400 ? "end" : "middle";
      const labelX = anchor === "start" ? x - 40 : anchor === "end" ? x + 40 : x;
      const textStyle = print ? ' fill="#000" stroke="#fff"' : "";
      return `<g class="rowanMapArea">` +
        `<circle cx="${x}" cy="${y}" r="58" class="rowanMapDot rowanMapDot-${severity}" stroke-width="12"${fill}/>` +
        `<text x="${labelX}" y="${y - 150}" text-anchor="${anchor}" class="rowanMapName"${textStyle}>${esc(area.area)}</text>` +
        `<text x="${labelX}" y="${y - 90}" text-anchor="${anchor}" class="rowanMapStatus"${textStyle}>${esc(area.label)}</text>` +
        `</g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(title)}" class="rowanMapSvg">` +
    `<title>${esc(title)}</title>` +
    `<image href="${esc(imageUrl)}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"/>` +
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" class="rowanMapShade"${print ? ' fill="#fff" fill-opacity="0.15"' : ""}/>` +
    pipeSvg +
    areaSvg +
    `</svg>`;
}
