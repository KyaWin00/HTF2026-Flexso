import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import DateFormat from "sap/ui/core/format/DateFormat";
import Locale from "sap/ui/core/Locale";
import Formatting from "sap/base/i18n/Formatting";
import Log from "sap/base/Log";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import GroupHeaderListItem from "sap/m/GroupHeaderListItem";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type Context from "sap/ui/model/odata/v4/Context";
import type Button from "sap/m/Button";
import type List from "sap/m/List";
import type { Button$PressEvent } from "sap/m/Button";
import type { ListBase$UpdateFinishedEvent } from "sap/m/ListBase";
import type { SegmentedButton$SelectionChangeEvent } from "sap/m/SegmentedButton";

/** A row of /Timeline (srv/investigation-service.cds). */
interface TimelineRow {
  at: string;
  day: string;
  hour: number | string;
  changedBy: string | null;
  label: string;
  suspicious: boolean;
  night: boolean;
}

/** A row of /Bursts: suspicious changes by one name within one minute. */
interface BurstRow {
  at: string;
  changedBy: string | null;
  count: number;
  labels: string;
  night: boolean;
  nonHuman: boolean;
}

/** A row of /SuspiciousRecords (the mark button and the board need it). */
interface SuspiciousRow {
  recordType: string;
  recordId: string;
  label: string;
  value?: string | null;
  changedAt?: string | null;
  changedBy?: string | null;
  reasons: string;
  reasonCount?: number;
  marked: boolean;
}

/** Short labels of Ilse's signs on the board's cards. */
const CHIP_KEYS: Readonly<Record<string, string>> = {
  negative: "chipNegative",
  futureDate: "chipFutureDate",
  nonHuman: "chipNonHuman",
  noName: "chipNoName",
  night: "chipNight",
  tooHigh: "chipTooHigh",
  contradiction: "chipContradiction",
};

/** Splits a text into at most `lines` lines of about `width` characters (ellipsis when cut). */
function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width && line) {
      out.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) out.push(line);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1].slice(0, width - 1)}…`;
    return kept;
  }
  return out;
}

/** i18n keys of Ilse's signs (srv/lib/record-doubt.ts). */
const SIGN_KEYS: Readonly<Record<string, string>> = {
  negative: "signNegative",
  futureDate: "signFutureDate",
  nonHuman: "signNonHuman",
  noName: "signNoName",
  night: "signNight",
  tooHigh: "signTooHigh",
  contradiction: "signContradiction",
};

// Ilse: "'system' is geen mens"; CAP writes "anonymous" when nobody is logged in ("geen naam").
const NON_HUMAN = new Set(["system"]);
const NO_NAME = new Set(["", "anonymous"]);

/** The night clock (own SVG): one row per day, 24 hours wide, the night (0–4 h) shaded. */
const CLOCK = { left: 116, hourWidth: 22, rowHeight: 24, top: 26 };
const NIGHT_UNTIL = 4;

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Ilse's register: which records of the village cannot be trusted, and why; when it happened; and her
 * mark "niet te vertrouwen" so Maren, Tobin and the council don't act on a false number.
 * Times are shown as stored in the village records (UTC) — Ilse herself speaks of "03:13".
 *
 * @namespace oakhaven.ilse.controller
 */
export default class Main extends Controller {
  private bundle?: ResourceBundle;
  // Dutch day and month names, also when the launchpad runs in another language.
  private readonly dayFormat = DateFormat.getDateInstance({ pattern: "EEEE d MMMM", UTC: true }, new Locale("nl"));
  private readonly shortDayFormat = DateFormat.getDateInstance({ pattern: "EEE d MMM", UTC: true }, new Locale("nl"));
  private readonly timeFormat = DateFormat.getTimeInstance({ pattern: "HH:mm", UTC: true }, new Locale("nl"));

  public onInit(): void {
    // Dutch dates, also inside the launchpad (which follows the browser language).
    Formatting.setLanguageTag("nl");
    this.getView()?.setModel(
      new JSONModel({
        headline: "",
        boardSvg: "<div></div>",
        facts: { records: 0, nights: 0, contradictions: 0, marks: 0 },
        clockSvg: "<div></div>",
        textsReady: false,
        suspiciousCount: 0,
      }),
      "view",
    );
    void this.load();
  }

  // ---------------------------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------------------------

  /** All of Ilse's signs of a record, one per line ("ik wil bij elke regel wél álle redenen zien"). */
  public reasonsText(reasons: string | null, contradiction: string | null, _ready: boolean): string {
    return (reasons ?? "")
      .split(",")
      .filter(Boolean)
      .map((sign) =>
        sign === "contradiction" && contradiction
          ? `• ${this.text("signContradictionDetail", [contradiction])}`
          : `• ${this.text(SIGN_KEYS[sign] ?? sign)}`,
      )
      .join("\n");
  }

  public dateTimeText(at: string | null, _ready: boolean): string {
    if (!at) return "";
    const date = new Date(at);
    return this.text("changedOn", [this.shortDayFormat.format(date), this.timeFormat.format(date)]);
  }

  public timeText(at: string | null, _ready: boolean): string {
    return at ? this.timeFormat.format(new Date(at)) : "";
  }

  /** "door 'system'" — or "zonder naam". */
  public whoText(name: string | null, _ready: boolean): string {
    return NO_NAME.has((name ?? "").trim().toLowerCase()) ? this.text("changedByNobody") : this.text("changedBy", [name]);
  }

  public whoName(name: string | null, _ready: boolean): string {
    return NO_NAME.has((name ?? "").trim().toLowerCase()) ? this.text("changedByNobody") : `"${name ?? ""}"`;
  }

  /** A name that is no human, or no name at all, stands out (text + icon + colour). */
  public whoState(name: string | null): string {
    const n = (name ?? "").trim().toLowerCase();
    return NON_HUMAN.has(n) || NO_NAME.has(n) ? "Error" : "None";
  }

  public whoIcon(name: string | null): string {
    const n = (name ?? "").trim().toLowerCase();
    if (NON_HUMAN.has(n)) return "sap-icon://ti/robot";
    if (NO_NAME.has(n)) return "sap-icon://ti/user-question";
    return "sap-icon://person-placeholder";
  }

  /** Group header of the timeline: the day in words. */
  public createGroupHeader(group: { key?: unknown }): GroupHeaderListItem {
    const day = typeof group.key === "string" ? group.key : "";
    return new GroupHeaderListItem({ title: day ? this.dayFormat.format(new Date(`${day}T12:00:00Z`)) : "" });
  }

  // ---------------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------------

  public onSuspiciousUpdated(event: ListBase$UpdateFinishedEvent): void {
    this.viewModel().setProperty("/suspiciousCount", event.getParameter("total") ?? 0);
  }

  /** Alles / Alleen verdacht / Alleen 's nachts. */
  public onTimelineFilter(event: SegmentedButton$SelectionChangeEvent): void {
    const key = event.getParameter("item")?.getKey();
    const binding = (this.byId("timelineList") as List | undefined)?.getBinding("items") as ODataListBinding | undefined;
    if (!binding) return;
    if (key === "suspicious") binding.filter(new Filter("suspicious", FilterOperator.EQ, true));
    else if (key === "night") binding.filter(new Filter("night", FilterOperator.EQ, true));
    else binding.filter([]);
  }

  /** Mark a record "niet te vertrouwen", or lift the mark again (always asks first). */
  public onToggleMark(event: Button$PressEvent): void {
    const button = event.getSource();
    const row = (button.getBindingContext() as Context | undefined)?.getObject() as SuspiciousRow | undefined;
    if (!row) return;
    const yes = this.text(row.marked ? "unmarkYes" : "markYes");
    MessageBox.confirm(this.text(row.marked ? "unmarkConfirm" : "markConfirm", [row.label]), {
      title: this.text(row.marked ? "unmarkTitle" : "markTitle"),
      actions: [yes, this.text("cancel")],
      emphasizedAction: yes,
      onClose: (action: unknown) => {
        if (action === yes) void this.toggleMark(row, button);
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Loading, report and night clock
  // ---------------------------------------------------------------------------------------------

  private viewModel(): JSONModel {
    return this.getView()?.getModel("view") as JSONModel;
  }

  private text(key: string, args: unknown[] = []): string {
    return this.bundle?.getText(key, args) ?? "";
  }

  private async load(): Promise<void> {
    const i18n = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
    this.bundle = (await i18n?.getResourceBundle()) ?? undefined;
    this.viewModel().setProperty("/textsReady", true);
    await this.loadOverview();
  }

  /** Reads timeline, bursts, records and marks once, and writes the report and the night clock. */
  private async loadOverview(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!model) return;
    try {
      const [timeline, bursts, records, marks] = await Promise.all([
        model.bindList("/Timeline", undefined, [], [], { $select: "at,day,hour,changedBy,label,suspicious,night" }).requestContexts(0, 1000),
        model.bindList("/Bursts", undefined, [], [], { $select: "at,changedBy,count,labels,night,nonHuman" }).requestContexts(0, 100),
        model.bindList("/SuspiciousRecords", undefined, [], [], { $select: "recordType,recordId,label,value,changedAt,changedBy,reasons,reasonCount,marked" }).requestContexts(0, 1000),
        model.bindList("/TrustMarks", undefined, [], [new Filter("active", FilterOperator.EQ, true)], { $select: "ID" }).requestContexts(0, 1000),
      ]);
      const events = timeline.map((c) => c.getObject() as TimelineRow);
      this.writeFindings(
        events,
        bursts.map((c) => c.getObject() as BurstRow),
        records.map((c) => c.getObject() as SuspiciousRow),
        marks.length,
      );
      this.drawClock(events);
    } catch (error: unknown) {
      Log.warning("Could not read the investigation", String(error), "oakhaven.ilse");
    }
  }

  /** What we found: one headline, the facts in a row, and the investigator's board. */
  private writeFindings(events: TimelineRow[], bursts: BurstRow[], records: SuspiciousRow[], markCount: number): void {
    const suspicious = events.filter((e) => e.suspicious).sort((x, y) => x.at.localeCompare(y.at));
    const days = new Set(suspicious.map((e) => e.day));
    const first = suspicious[0];
    let headline = this.text("headlineNone");
    if (first && days.size === 1) {
      const at = new Date(first.at);
      // "of het in één keer gebeurde of beetje bij beetje" — and was it at night?
      headline = suspicious.every((e) => e.night)
        ? this.text("headlineOneNight", [this.dayFormat.format(at), this.timeFormat.format(at)])
        : this.text("headlineOneDay", [this.dayFormat.format(at)]);
    } else if (days.size > 1) {
      headline = this.text("headlineManyDays", [days.size]);
    }
    this.viewModel().setProperty("/headline", headline);
    this.viewModel().setProperty("/facts", {
      records: records.length,
      nights: days.size,
      contradictions: records.filter((r) => r.reasons.split(",").includes("contradiction")).length,
      marks: markCount,
    });
    this.viewModel().setProperty("/boardSvg", this.drawBoard(bursts[0], records));
  }

  /**
   * The investigator's board: the name in the middle (who, when, at night?), the records it changed in
   * that same minute around it — each with its signs — tied to it with a dashed string.
   * Without such a burst: the most suspicious records around the name that changed most of them.
   */
  private drawBoard(burst: BurstRow | undefined, records: SuspiciousRow[]): string {
    const sorted = [...records].sort((x, y) => (y.reasonCount ?? 0) - (x.reasonCount ?? 0));
    const minute = burst?.at.slice(0, 16);
    const group = burst
      ? sorted.filter((r) => r.changedBy === burst.changedBy && (r.changedAt ?? "").slice(0, 16) === minute)
      : sorted.slice(0, 4);
    if (group.length === 0) return "<div></div>";
    const who = burst?.changedBy ?? group[0].changedBy ?? "";
    const at = burst ? new Date(burst.at) : null;

    const W = 600;
    const H = 330;
    const cx = W / 2;
    const cy = H / 2;
    const CARD_W = 196;
    const CARD_H = 92;
    const spots = [
      [CARD_W / 2 + 6, 58],
      [W - CARD_W / 2 - 6, 58],
      [cx, H - CARD_H / 2 - 4],
      [CARD_W / 2 + 6, H - CARD_H / 2 - 4],
      [W - CARD_W / 2 - 6, H - CARD_H / 2 - 4],
    ];
    const order = group.length === 4 ? [0, 1, 3, 4] : [0, 1, 2, 3, 4];
    const strings: string[] = [];
    const cards: string[] = [];
    group.slice(0, order.length).forEach((record, i) => {
      const [x, y] = spots[order[i]];
      strings.push(`<line class="boardString" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`);
      const left = x - CARD_W / 2 + 10;
      const top = y - CARD_H / 2;
      const title = wrap(record.label, 30, 2);
      const chips = wrap(
        record.reasons.split(",").filter(Boolean).map((s) => this.text(CHIP_KEYS[s] ?? s)).join(" · "),
        32,
        2,
      );
      const lines = [
        ...title.map((t, n) => `<text class="boardTitle" x="${left}" y="${top + 18 + n * 15}">${escapeXml(t)}</text>`),
        `<text class="boardValue" x="${left}" y="${top + 18 + title.length * 15}">${escapeXml(record.value ?? "")}</text>`,
        ...chips.map((t, n) => `<text class="boardChips" x="${left}" y="${top + 18 + (title.length + 1) * 15 + n * 14}">${escapeXml(t)}</text>`),
      ];
      cards.push(
        `<g><rect class="boardCard" x="${x - CARD_W / 2}" y="${top}" width="${CARD_W}" height="${CARD_H}" rx="4"/>${lines.join("")}</g>`,
      );
    });
    const center =
      `<circle class="boardCenter" cx="${cx}" cy="${cy}" r="54"/>` +
      `<text class="boardWho" x="${cx}" y="${cy - (at ? 8 : -6)}" text-anchor="middle">"${escapeXml(who)}"</text>` +
      (at
        ? `<text class="boardWhen" x="${cx}" y="${cy + 10}" text-anchor="middle">${escapeXml(this.shortDayFormat.format(at))}</text>` +
          `<text class="boardWhen" x="${cx}" y="${cy + 26}" text-anchor="middle">${escapeXml(this.timeFormat.format(at))}${burst?.night ? ` · ${escapeXml(this.text("boardNight"))}` : ""}</text>`
        : "");
    const alt = escapeXml(this.text("boardAlt", [who, group.length]));
    return `<div class="ilseBoard"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${alt}">${strings.join("")}${cards.join("")}${center}</svg></div>`;
  }

  /** The night clock: each day with changes is a row from 0 to 24 h; the night is shaded. */
  private drawClock(events: TimelineRow[]): void {
    const days = [...new Set(events.map((e) => e.day))].sort().reverse();
    const width = CLOCK.left + 24 * CLOCK.hourWidth + 10;
    const height = CLOCK.top + days.length * CLOCK.rowHeight + 6;
    const x = (hour: number): number => CLOCK.left + hour * CLOCK.hourWidth;
    const parts: string[] = [];
    // the night band and the hour scale
    parts.push(`<rect class="clockNight" x="${x(0)}" y="${CLOCK.top - 6}" width="${NIGHT_UNTIL * CLOCK.hourWidth}" height="${days.length * CLOCK.rowHeight + 6}"/>`);
    parts.push(`<text class="clockNightLabel" x="${x(NIGHT_UNTIL / 2)}" y="${CLOCK.top - 10}" text-anchor="middle">${escapeXml(this.text("clockNight"))}</text>`);
    for (const hour of [0, 4, 8, 12, 16, 20, 24]) {
      parts.push(`<text class="clockHour" x="${x(hour)}" y="12" text-anchor="middle">${hour}</text>`);
    }
    days.forEach((day, row) => {
      const y = CLOCK.top + row * CLOCK.rowHeight + CLOCK.rowHeight / 2;
      const hasSuspicious = events.some((e) => e.day === day && e.suspicious);
      parts.push(`<line class="clockRow" x1="${x(0)}" y1="${y}" x2="${x(24)}" y2="${y}"/>`);
      parts.push(
        `<text class="clockDay${hasSuspicious ? " clockDay--suspicious" : ""}" x="${CLOCK.left - 8}" y="${y + 4}" text-anchor="end">` +
          `${escapeXml(this.shortDayFormat.format(new Date(`${day}T12:00:00Z`)))}</text>`,
      );
      for (const e of events.filter((ev) => ev.day === day)) {
        const title = escapeXml(`${this.timeFormat.format(new Date(e.at))} ${e.changedBy ?? ""}: ${e.label}`);
        parts.push(
          `<circle class="${e.suspicious ? "clockDot clockDot--suspicious" : "clockDot"}" cx="${x(Number(e.hour))}" cy="${y}" r="${e.suspicious ? 6 : 3.5}"><title>${title}</title></circle>`,
        );
      }
    });
    this.viewModel().setProperty(
      "/clockSvg",
      `<div class="ilseClockSvg"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(this.text("clockAlt"))}">${parts.join("")}</svg></div>`,
    );
  }

  private async toggleMark(row: SuspiciousRow, button: Button): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!model) return;
    button.setBusy(true);
    const action = model.bindContext(row.marked ? "/clearMark(...)" : "/markUntrusted(...)");
    action.setParameter("recordType", row.recordType).setParameter("recordId", row.recordId);
    if (!row.marked) action.setParameter("label", row.label).setParameter("note", "");
    try {
      await action.invoke();
      MessageToast.show(this.text(row.marked ? "unmarkDone" : "markDone"));
      (this.byId("suspiciousTable") as List | undefined)?.getBinding("items")?.refresh();
      await this.loadOverview();
    } catch (error: unknown) {
      MessageBox.error(error instanceof Error ? error.message : String(error));
    } finally {
      button.setBusy(false);
      action.destroy();
    }
  }
}
