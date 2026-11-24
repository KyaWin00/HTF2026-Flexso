/**
 * Formatters for the council overview. Texts are passed in from i18n (see the `parts` in Main.view.xml),
 * so this module stays free of UI state.
 *
 * @namespace oakhaven.rowan.model
 */

/** Maren's water level → semantic state (status is always text + icon + colour). */
function levelState(level: string | null): string {
  if (level === "alarm") return "Error";
  if (level === "attention") return "Warning";
  if (level === "ok") return "Success";
  return "None";
}

function levelIcon(level: string | null): string {
  if (level === "alarm") return "sap-icon://ti/alert-octagon";
  if (level === "attention") return "sap-icon://ti/alert-triangle";
  return "sap-icon://ti/circle-check";
}

function levelText(level: string | null, alarm: string, attention: string, ok: string): string {
  if (level === "alarm") return alarm;
  if (level === "attention") return attention;
  return level === "ok" ? ok : "";
}

/** Doubtful number (one of Ilse's signs) → Warning; nothing found → Success. */
function doubtState(doubtful: boolean | null): string {
  return doubtful ? "Warning" : "Success";
}

function doubtIcon(doubtful: boolean | null): string {
  return doubtful ? "sap-icon://ti/question-mark" : "sap-icon://ti/check";
}

/**
 * Comma-separated reason codes from the service → readable list.
 * Order of the texts: trusted, negative, futureDate, impossibleFlow, system, night.
 */
function doubtText(
  reasons: string | null,
  trusted: string,
  negative: string,
  futureDate: string,
  impossibleFlow: string,
  system: string,
  night: string,
): string {
  const texts: Record<string, string> = { negative, futureDate, impossibleFlow, system, night };
  const list = (reasons ?? "").split(",").filter((code) => code !== "");
  return list.length === 0 ? trusted : list.map((code) => texts[code] ?? code).join(" · ");
}

export default { levelState, levelIcon, levelText, doubtState, doubtIcon, doubtText };
