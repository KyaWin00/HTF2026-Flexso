import Log from "sap/base/Log";
import MessageBox from "sap/m/MessageBox";
import type List from "sap/m/List";
import Controller from "sap/ui/core/mvc/Controller";
import DateFormat from "sap/ui/core/format/DateFormat";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import Formatter from "../model/formatter";
import { villageMapSvg, type MapArea, type MapPipe } from "../model/villageMap";

/** View state: the budget and the totals of the proposal. */
interface PageState {
  budget: number;
  proposalSpent: number;
  proposalLeft: number;
  notProposedCount: number;
  /** Products whose number cannot be trusted — the same pantry for every area, shown once. */
  foodCheck: string;
  /** The village map as SVG markup (model/villageMap.ts). */
  mapSvg: string;
  /** Share of the budget the proposal uses, for the budget bar. */
  proposalPercent: number;
}

/** A VillageOverview row (CouncilService). */
interface OverviewRow {
  area?: string;
  gridCell?: string | null;
  severity?: number;
  households?: number | null;
  waterLevel?: string;
  waterCause?: string;
  foodLevel?: string;
  foodCause?: string;
  foodCheck?: string;
}

/** A ProposalLines row (CouncilService). */
interface ProposalRow {
  position?: number | null;
  kind?: string;
  title?: string;
  emptyDate?: string | null;
  areas?: string;
  households?: number | null;
  need?: string | null;
  status?: string;
  cost?: number | string;
  doubtReasons?: string;
}

/** The slice of the browser window the print sheet uses (the project's tsconfig has no DOM types). */
interface PrintWindow {
  readonly document: { open(): void; write(markup: string): void; close(): void };
  focus(): void;
  print(): void;
}
interface BrowserWindow {
  open(url: string, target: string): PrintWindow | null;
}

/** Escapes text for the print sheet (data comes from the server, never trusted as HTML). */
function html(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Calm black-and-white layout for paper: page 1 the overview, page 2 the proposal. */
const PRINT_STYLE = `
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 2cm; font-size: 12pt; }
  h1 { font-size: 22pt; text-transform: uppercase; letter-spacing: .03em; margin: 0 0 .2cm; }
  .meta { color: #444; margin-bottom: .6cm; }
  table { width: 100%; border-collapse: collapse; margin-top: .3cm; }
  th, td { text-align: left; vertical-align: top; padding: .25cm .2cm; border-bottom: 1px solid #999; }
  th { font-size: 10pt; text-transform: uppercase; color: #444; }
  .big { font-size: 14pt; font-weight: bold; }
  .red { font-weight: bold; }
  .muted { color: #444; font-size: 10pt; }
  .warn { margin-top: .1cm; font-size: 10pt; }
  .num { text-align: right; white-space: nowrap; }
  .box { display: inline-block; width: .4cm; height: .4cm; border: 1px solid #000; margin: 0 .1cm 0 .3cm; vertical-align: middle; }
  .page { page-break-after: always; }
  .map svg { width: 100%; height: auto; margin: .3cm 0; border: 1px solid #999; }
  .map .rowanMapName { font: bold 56px Arial, sans-serif; paint-order: stroke; stroke-width: 10px; }
  .map .rowanMapStatus { font: 44px Arial, sans-serif; paint-order: stroke; stroke-width: 10px; }
`;

/**
 * Rowan's Monday: first how Oakhaven is doing (water and food per area, worst first), then the
 * proposal for the 500 kronen with one line of why. They read it together, on paper — hence the
 * print sheet. The raw tables are folded away under "Alle cijfers".
 *
 * @namespace oakhaven.rowan.controller
 */
export default class Main extends Controller {
  private readonly state = new JSONModel({
    budget: 0,
    proposalSpent: 0,
    proposalLeft: 0,
    notProposedCount: 0,
    foodCheck: "",
    mapSvg: "",
    proposalPercent: 0,
  } satisfies PageState);

  /** The pipes on the map (route + Maren's level), loaded once with the overview. */
  private mapPipes: MapPipe[] = [];

  public onInit(): void {
    this.getView()?.setModel(this.state, "view");
    void this.loadBudget();
  }

  /** Asks the service for the weekly budget (Rowan: 500 kronen). */
  private async loadBudget(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!model) return;
    const call = model.bindContext("/weekBudget(...)");
    try {
      await call.invoke();
      const result = call.getBoundContext().getObject() as { value?: number } | undefined;
      this.state.setProperty("/budget", result?.value ?? 0);
      this.onProposalUpdated();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Log.error("Could not load the week budget", message, "oakhaven.rowan");
      MessageBox.error(message);
    }
  }

  /** The overview has loaded: the pantry's untrusted products are shown once, below the areas. */
  public async onOverviewUpdated(): Promise<void> {
    const rows = this.rowsOf<OverviewRow>("overviewList");
    this.state.setProperty("/foodCheck", rows.find((row) => row.foodCheck)?.foodCheck ?? "");
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (model) {
      try {
        const contexts = await model.bindList("/MapPipes").requestContexts(0, 100);
        this.mapPipes = contexts.map((context) => context.getObject() as MapPipe);
      } catch (error: unknown) {
        Log.warning("Village map: pipes not loaded", String(error), "oakhaven.rowan");
      }
    }
    const bundle = await this.getBundle();
    this.state.setProperty("/mapSvg", `<div class="rowanMap">${this.mapSvg(rows, bundle, false)}</div>`);
  }

  /** The map with the areas' status in words (never colour alone). */
  private mapSvg(rows: OverviewRow[], bundle: ResourceBundle, print: boolean): string {
    const t = (key: string): string => bundle.getText(key) ?? key;
    const areas: MapArea[] = rows.map((row) => ({
      area: row.area,
      gridCell: row.gridCell,
      severity: row.severity,
      label: bundle.getText("mapLabel", [
        Formatter.levelText(row.waterLevel ?? null, t("levelAlarm"), t("levelAttention"), t("levelOk")),
        Formatter.foodText(row.foodLevel ?? null, t("foodHunger"), t("foodTight"), t("foodOk")),
      ]) ?? "",
    }));
    let image = sap.ui.require.toUrl("oakhaven/rowan/img/oakhaven-map.jpg");
    // The print window is a blank page: it needs the full address of the map image.
    if (print) image = new URL(image, (globalThis as unknown as { location: { href: string } }).location.href).href;
    return villageMapSvg(image, this.mapPipes, areas, t("mapTitle"), print);
  }

  /** The proposal has loaded: what it spends, what is left, how many lines are left out. */
  public onProposalUpdated(): void {
    const rows = this.rowsOf<ProposalRow>("proposalList");
    const proposed = rows.filter((row) => row.status === "proposed");
    const spent = proposed.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
    const budget = Number(this.state.getProperty("/budget")) || 0;
    this.state.setProperty("/proposalSpent", spent);
    this.state.setProperty("/proposalLeft", budget - spent);
    this.state.setProperty("/notProposedCount", rows.length - proposed.length);
    this.state.setProperty("/proposalPercent", budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0);
  }

  /**
   * Rowan: "we lezen het samen rond de tafel in Shepherd's Inn, en het liefst op papier".
   * Opens a plain two-page sheet and the browser's print dialog: page 1 how Oakhaven is doing,
   * page 2 the proposal, with a box per line for the council's own yes/no.
   */
  public async onPrint(): Promise<void> {
    const bundle = await this.getBundle();
    const t = (key: string, args?: unknown[]): string => bundle.getText(key, args as string[]) ?? key;
    const overview = this.rowsOf<OverviewRow>("overviewList");
    const lines = this.rowsOf<ProposalRow>("proposalList");
    const state = this.state.getData() as PageState;
    const date = DateFormat.getDateInstance({ pattern: "d MMMM yyyy" }).format(new Date());
    const doubtTexts = [t("doubtNegative"), t("doubtFutureDate"), t("doubtImpossibleFlow"), t("doubtSystem"), t("doubtNight")] as const;
    const reason = (row: ProposalRow): string =>
      Formatter.reasonText(
        row.need ?? null,
        row.status ?? null,
        row.areas ?? null,
        t("reasonNoWaterNow"),
        t("reasonWaterRisk"),
        t("reasonHunger"),
        t("reasonOverBudget"),
        t("reasonCheckFirst"),
        t("reasonNoRule"),
        t("reasonOrderInTime"),
        t("reasonNobody"),
      );

    const without = (row: ProposalRow): string =>
      Formatter.withoutText(
        row.kind ?? null,
        row.need ?? null,
        row.areas ?? null,
        row.title ?? null,
        row.emptyDate ?? null,
        t("withoutNoWater"),
        t("withoutWaterRisk"),
        t("withoutFoodDate"),
        t("withoutFood"),
      );

    const areaRows = overview
      .map((row) => {
        const water = Formatter.levelText(row.waterLevel ?? null, t("levelAlarm"), t("levelAttention"), t("levelOk"));
        const food = Formatter.foodText(row.foodLevel ?? null, t("foodHunger"), t("foodTight"), t("foodOk"));
        const households = row.households ? `<div class="muted">${html(t("proposalHouseholds", [row.households]))}</div>` : "";
        return `<tr>
          <td><span class="big">${html(row.area)}</span>${households}</td>
          <td class="${row.waterLevel === "ok" ? "" : "red"}">${html(water)}${row.waterCause ? `<div class="muted">${html(t("waterBy", [row.waterCause]))}</div>` : ""}</td>
          <td class="${row.foodLevel === "ok" ? "" : "red"}">${html(food)}${row.foodCause ? `<div class="muted">${html(row.foodCause)}</div>` : ""}</td>
        </tr>`;
      })
      .join("");

    const proposedRows = lines
      .filter((row) => row.status === "proposed")
      .map((row) => {
        const doubt = row.doubtReasons
          ? `<div class="warn">⚠ ${html(Formatter.proposalDoubt(row.doubtReasons, t("proposalDoubt"), ...doubtTexts))}</div>`
          : "";
        return `<tr>
          <td class="big">${html(row.position)}</td>
          <td><span class="big">${html(row.title)}</span><div>${html(reason(row))}</div><div class="muted">${html(without(row))}</div>${doubt}</td>
          <td class="num">${html(row.cost)} ${html(t("unitKronen"))}</td>
          <td class="num">${html(t("printYes"))}<span class="box"></span>${html(t("printNo"))}<span class="box"></span></td>
        </tr>`;
      })
      .join("");

    const leftOut = lines
      .filter((row) => row.status !== "proposed")
      .map((row) => `<li><b>${html(row.title)}</b>: ${html(reason(row))}</li>`)
      .join("");

    const sheet = `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><title>${html(t("appTitle"))}</title>
      <style>${PRINT_STYLE}</style></head><body>
      <div class="page">
        <div class="meta">${html(t("printDate", [date]))}</div>
        <h1>${html(t("overviewTitle"))}</h1>
        <div class="muted">${html(t("overviewIntro"))}</div>
        <div class="map">${this.mapSvg(overview, bundle, true)}</div>
        <table><tr><th>${html(t("colArea"))}</th><th>${html(t("labelWater"))}</th><th>${html(t("labelFood"))}</th></tr>${areaRows}</table>
        ${state.foodCheck ? `<p class="warn">⚠ ${html(t("foodCheck", [state.foodCheck]))}</p>` : ""}
      </div>
      <div>
        <div class="meta">${html(t("printDate", [date]))}</div>
        <h1>${html(t("printPage2"))}</h1>
        <p class="big">${html(t("proposalSummary", [state.proposalSpent, state.budget, state.proposalLeft]))}</p>
        <p class="muted">${html(t("leftOverNote"))}</p>
        <p class="muted">${html(t("proposalOrder"))}</p>
        <table><tr><th>#</th><th></th><th class="num">${html(t("colCost"))}</th><th class="num">${html(t("printDecided"))}</th></tr>${proposedRows}</table>
        ${leftOut ? `<p class="muted">${html(t("notProposedTitle", [state.notProposedCount]))}</p><ul class="muted">${leftOut}</ul>` : ""}
        <p class="muted">${html(t("advice"))}</p>
      </div>
      </body></html>`;

    const browser = globalThis as unknown as BrowserWindow;
    const printWindow = browser.open("", "_blank");
    if (!printWindow) {
      MessageBox.error(t("print"));
      return;
    }
    printWindow.document.open();
    printWindow.document.write(sheet);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  private rowsOf<T>(listId: string): T[] {
    const list = this.byId(listId) as List | undefined;
    const binding = list?.getBinding("items") as ODataListBinding | undefined;
    return binding ? binding.getCurrentContexts().map((context) => context.getObject() as T) : [];
  }

  private async getBundle(): Promise<ResourceBundle> {
    const i18n = this.getOwnerComponent()?.getModel("i18n") as ResourceModel;
    return await i18n.getResourceBundle();
  }
}
