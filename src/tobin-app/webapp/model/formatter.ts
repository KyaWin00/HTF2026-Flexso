import formatMessage from "sap/base/strings/formatMessage";
import { ValueState } from "sap/ui/core/library";
import { IconColor } from "sap/ui/core/library";

/**
 * Formatters of the bakery week: map the codes of srv/lib/bakery-week.ts to a semantic state and
 * an icon. The TEXTS for those codes are in i18n.properties (picked in the view).
 *
 * @namespace oakhaven.tobin.model
 */

/** Advice codes, most urgent first (see Advice in srv/lib/bakery-week.ts). */
export type Advice = "impossible" | "late" | "today" | "soon" | "ok" | "unknown";

/** Day levels of the outlook (see DayLevel in srv/lib/bakery-week.ts). */
export type DayLevel = "ok" | "belowComfort" | "empty";

const ADVICE_STATE: Record<Advice, ValueState> = {
  impossible: ValueState.Error,
  late: ValueState.Error,
  today: ValueState.Error,
  soon: ValueState.Warning,
  ok: ValueState.Success,
  unknown: ValueState.Information,
};

const ADVICE_ICON: Record<Advice, string> = {
  impossible: "sap-icon://question-mark",
  late: "sap-icon://error",
  today: "sap-icon://alert",
  soon: "sap-icon://pending",
  ok: "sap-icon://sys-enter-2",
  unknown: "sap-icon://hint",
};

const LEVEL_STATE: Record<DayLevel, ValueState> = {
  ok: ValueState.Success,
  belowComfort: ValueState.Warning,
  empty: ValueState.Error,
};

const LEVEL_ICON: Record<DayLevel, string> = {
  ok: "sap-icon://sys-enter-2",
  belowComfort: "sap-icon://alert",
  empty: "sap-icon://sys-cancel",
};

const STATE_COLOR: Record<string, IconColor> = {
  [ValueState.Error]: IconColor.Negative,
  [ValueState.Warning]: IconColor.Critical,
  [ValueState.Success]: IconColor.Positive,
  [ValueState.Information]: IconColor.Neutral,
};

function isAdvice(value: unknown): value is Advice {
  return typeof value === "string" && value in ADVICE_STATE;
}

function isDayLevel(value: unknown): value is DayLevel {
  return typeof value === "string" && value in LEVEL_STATE;
}

export default {
  adviceState(advice: unknown): ValueState {
    return isAdvice(advice) ? ADVICE_STATE[advice] : ValueState.None;
  },

  adviceIcon(advice: unknown): string {
    return isAdvice(advice) ? ADVICE_ICON[advice] : "";
  },

  levelState(level: unknown): ValueState {
    return isDayLevel(level) ? LEVEL_STATE[level] : ValueState.None;
  },

  levelIcon(level: unknown): string {
    return isDayLevel(level) ? LEVEL_ICON[level] : "";
  },

  /** Icon colour that matches a ValueState (for the lines of the morning message). */
  stateColor(state: unknown): IconColor {
    return typeof state === "string" && state in STATE_COLOR ? STATE_COLOR[state] : IconColor.Default;
  },

  /** A text with one placeholder for "<quantity> <unit>", e.g. "… minder dan 18 kg …"; unit texts from i18n. */
  quantityText(template: string, quantity: unknown, unit: unknown, unitKg: string, unitLiter: string): string {
    if (typeof quantity !== "string" || quantity === "") return "";
    let unitText = typeof unit === "string" ? unit : "";
    if (unit === "KG") unitText = unitKg;
    else if (unit === "L") unitText = unitLiter;
    return formatMessage(template, [`${quantity} ${unitText}`.trim()]);
  },

  /** "1 dag na bestellen" or "3 dagen na bestellen", with the supplier: texts from i18n. */
  deliveryText(days: unknown, supplier: unknown, oneDay: string, manyDays: string): string {
    const count = typeof days === "number" || typeof days === "string" ? Number(days) : NaN;
    if (days === null || days === "" || !Number.isFinite(count)) return "";
    return formatMessage(count === 1 ? oneDay : manyDays, [count, typeof supplier === "string" ? supplier : ""]);
  },
};
