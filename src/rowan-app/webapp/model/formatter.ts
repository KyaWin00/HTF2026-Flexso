import formatMessage from "sap/base/strings/formatMessage";

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

/** Tobin's food level → semantic state: hunger (panic) red, tight (nervous) orange, ok green. */
function foodState(level: string | null): string {
  if (level === "hunger") return "Error";
  if (level === "tight") return "Warning";
  if (level === "ok") return "Success";
  return "None";
}

function foodIcon(level: string | null): string {
  if (level === "hunger") return "sap-icon://ti/alert-octagon";
  if (level === "tight") return "sap-icon://ti/alert-triangle";
  return "sap-icon://ti/circle-check";
}

function foodText(level: string | null, hunger: string, tight: string, ok: string): string {
  if (level === "hunger") return hunger;
  if (level === "tight") return tight;
  return level === "ok" ? ok : "";
}

/**
 * Why a proposal line is (not) in the proposal. Proposed lines explain their need; the others
 * explain why the money does not go there. Texts from i18n, in the order of the parameters.
 */
function reasonText(
  need: string | null,
  status: string | null,
  areas: string | null,
  noWaterNow: string,
  waterRisk: string,
  hunger: string,
  overBudget: string,
  checkFirst: string,
  noRule: string,
  orderInTime: string,
  nobody: string,
): string {
  if (status === "proposed") {
    if (need === "noWaterNow") return formatMessage(noWaterNow, [areas ?? ""]);
    if (need === "waterRisk") return formatMessage(waterRisk, [areas ?? ""]);
    if (need === "orderTooLate") return hunger;
    return "";
  }
  const byStatus: Record<string, string> = { overBudget, checkFirst, noRule, orderInTime, nobodyAffected: nobody };
  return byStatus[status ?? ""] ?? "";
}

/** "Let op, Ilse ziet …: <signs>" — on a line that is proposed anyway (its own numbers hold up). */
function proposalDoubt(
  reasons: string | null,
  template: string,
  negative: string,
  futureDate: string,
  impossibleFlow: string,
  system: string,
  night: string,
): string {
  return formatMessage(template, [doubtText(reasons, "", negative, futureDate, impossibleFlow, system, night)]);
}

/** Proposed → Success, money ran out → Error, check first → Warning, the rest is information. */
function proposalState(status: string | null): string {
  if (status === "proposed") return "Success";
  if (status === "overBudget") return "Error";
  if (status === "checkFirst") return "Warning";
  return "None";
}

function proposalIcon(status: string | null): string {
  if (status === "proposed") return "sap-icon://ti/circle-check";
  if (status === "overBudget") return "sap-icon://ti/coins";
  if (status === "checkFirst") return "sap-icon://ti/question-mark";
  return "sap-icon://ti/minus";
}

export default {
  levelState,
  levelIcon,
  levelText,
  doubtState,
  doubtIcon,
  doubtText,
  foodState,
  foodIcon,
  foodText,
  reasonText,
  proposalDoubt,
  proposalState,
  proposalIcon,
};
