import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import DateFormat from "sap/ui/core/format/DateFormat";
import Locale from "sap/ui/core/Locale";
import Device from "sap/ui/Device";
import Log from "sap/base/Log";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";
import type ListBase from "sap/m/ListBase";
import type { ListBase$UpdateFinishedEvent } from "sap/m/ListBase";
import type { ListItemBase$PressEvent } from "sap/m/ListItemBase";
import type Context from "sap/ui/model/odata/v4/Context";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type ManagedObject from "sap/ui/base/ManagedObject";
import type UI5Event from "sap/ui/base/Event";

/** One pipe of /MorningRound as the map needs it. */
interface RoundPipe {
  pipeID: string;
  startPoint: string;
  endPoint: string;
  mapPath: string | null;
  downstreamPipes: string | null;
  servedAreas: string | null;
  households: number | null;
  level: string | null;
  visitOrder: number | null;
  nobodyDependsOnIt: boolean | null;
}

/** The Screen Wake Lock API (in the browser, not yet in every TypeScript DOM typing). */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

/** The few browser DOM members this controller uses (the project compiles without the DOM lib). */
interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
}
interface EventTargetLike {
  addEventListener(type: string, listener: (event: { target: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { target: unknown }) => void): void;
}
interface DocumentLike extends EventTargetLike {
  readonly visibilityState: string;
}
const browser = globalThis as unknown as { document: DocumentLike; navigator: WakeLockNavigator };

/** The village map (README "The village map"): image size and where the 8×8 grid sits on it. */
const MAP = { width: 2048, height: 1536 };
const GRID = { x: 150, y: 120, width: 1750, height: 1280 };

/** The app reloads the round on its own, so Maren never has to tap "refresh" with wet gloves. */
const REFRESH_MS = 60_000;

/** Below this width the app shows only today's two stops (the phone view). */
const WIDE_RANGES = new Set(["Tablet", "Desktop", "LargeDesktop"]);

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Grid units ("x,y", from the south-west corner of A1) → image pixels. */
function toPixel(x: number, y: number): { x: number; y: number } {
  return { x: GRID.x + (x * GRID.width) / 8, y: GRID.y + ((8 - y) * GRID.height) / 8 };
}

function parsePath(mapPath: string | null): { x: number; y: number }[] {
  return (mapPath ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter((xy) => xy.length === 2 && xy.every(Number.isFinite))
    .map(([x, y]) => toPixel(x, y));
}

/**
 * Maren's morning round.
 * Phone (6am, in the field, wet gloves): only today's two stops, big, nothing to tap; the page
 * refreshes itself and keeps the screen awake. Laptop (evening): all pipes, the rules, and the
 * map where a click shows who runs dry when a pipe fails ("water loopt stroomafwaarts").
 *
 * @namespace oakhaven.maren.controller
 */
export default class Main extends Controller {
  private refreshTimer?: ReturnType<typeof setInterval>;
  private wakeLock?: WakeLockSentinelLike;
  private bundle?: ResourceBundle;
  private pipes: RoundPipe[] = [];
  private selectedPipe?: string;
  private readonly onVisibilityChange = (): void => {
    if (browser.document.visibilityState === "visible") void this.keepScreenOn();
  };
  private readonly onRangeChange = (params: { name?: string }): void => {
    this.viewModel().setProperty("/wide", WIDE_RANGES.has(params.name ?? ""));
  };
  private readonly onMapClick = (event: { target: unknown }): void => {
    const target = event.target as ElementLike | null;
    const pipeID = target?.closest("[data-pipe]")?.getAttribute("data-pipe");
    if (pipeID) this.selectPipe(pipeID);
  };

  public onInit(): void {
    const range = Device.media.getCurrentRange(Device.media.RANGESETS.SAP_STANDARD);
    this.getView()?.setModel(
      new JSONModel({
        todayText: this.todayText(),
        refreshedText: this.timeText(),
        wide: WIDE_RANGES.has(range?.name ?? ""),
        mapSvg: "<div></div>",
        dryText: "",
        noStops: false,
      }),
      "view",
    );
    Device.media.attachHandler(this.onRangeChange, this, Device.media.RANGESETS.SAP_STANDARD);

    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    browser.document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.keepScreenOn();
    void this.loadTexts();
  }

  public onExit(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    browser.document.removeEventListener("visibilitychange", this.onVisibilityChange);
    Device.media.detachHandler(this.onRangeChange, this, Device.media.RANGESETS.SAP_STANDARD);
    void this.wakeLock?.release();
  }

  /** Today's stops have (re)loaded: show the "niets te herstellen" card only when there are none. */
  public onStopsChange(event: UI5Event): void {
    const binding = event.getSource() as ODataListBinding;
    this.viewModel().setProperty("/noStops", binding.isLengthFinal() && binding.getLength() === 0);
  }

  /** The table has (re)loaded: redraw the map from the same rows. */
  public onRoundUpdated(event: ListBase$UpdateFinishedEvent): void {
    const table = event.getSource() as ListBase;
    this.pipes = table
      .getItems()
      .map((item) => item.getBindingContext() as Context | null | undefined)
      .filter((context): context is Context => !!context)
      .map((context) => context.getObject() as RoundPipe);
    this.drawMap();
  }

  /** A row in the table was clicked: show its "dry shadow" on the map. */
  public onPipePress(event: ListItemBase$PressEvent): void {
    const context = event.getSource().getBindingContext() as Context | null | undefined;
    const pipe = context?.getObject() as RoundPipe | undefined;
    if (pipe) this.selectPipe(pipe.pipeID);
  }

  /** The map's DOM is new after every redraw: listen for clicks on its pipes. */
  public onMapRendered(): void {
    (this.byId("map")?.getDomRef() as EventTargetLike | null | undefined)?.addEventListener("click", this.onMapClick);
  }

  private viewModel(): JSONModel {
    return this.getView()?.getModel("view") as JSONModel;
  }

  private async loadTexts(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
    this.bundle = (await model?.getResourceBundle()) ?? undefined;
    this.drawMap();
  }

  private text(key: string, args: unknown[] = []): string {
    return this.bundle?.getText(key, args) ?? "";
  }

  private todayText(): string {
    return DateFormat.getDateInstance({ pattern: "EEEE d MMMM" }, new Locale("nl")).format(new Date());
  }

  private timeText(): string {
    return DateFormat.getTimeInstance({ pattern: "HH:mm" }).format(new Date());
  }

  /** Reloads the lists (Maren never needs to press anything); the details only on a wide screen. */
  private refresh(): void {
    const wide = this.viewModel().getProperty("/wide") === true;
    for (const id of wide ? ["todayList", "laterList", "roundTable"] : ["todayList", "laterList"]) {
      (this.byId(id) as ManagedObject | undefined)?.getBinding("items")?.refresh();
    }
    this.viewModel().setProperty("/refreshedText", this.timeText());
    this.viewModel().setProperty("/todayText", this.todayText());
  }

  /** Keeps the phone screen on while the app is open (only on https or localhost). */
  private async keepScreenOn(): Promise<void> {
    const wakeLock = browser.navigator.wakeLock;
    if (!wakeLock || browser.document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await wakeLock.request("screen");
    } catch (error) {
      Log.info("Screen wake lock not available", String(error), "oakhaven.maren");
    }
  }

  private selectPipe(pipeID: string): void {
    this.selectedPipe = this.selectedPipe === pipeID ? undefined : pipeID;
    this.drawMap();
  }

  private levelText(level: string | null): string {
    if (level === "alarm") return this.text("levelAlarm");
    if (level === "attention") return this.text("levelAttention");
    return this.text("levelOk");
  }

  /** Builds the map: every pipe in its level (colour + dash pattern), visit numbers, dry shadow. */
  private drawMap(): void {
    if (!this.bundle || this.pipes.length === 0) return;
    const selected = this.pipes.find((p) => p.pipeID === this.selectedPipe);
    const dry = new Set((selected?.downstreamPipes ?? "").split(",").filter(Boolean));
    const mapUrl = sap.ui.require.toUrl("oakhaven/maren/img/oakhaven-map.jpg");

    const shadows: string[] = [];
    const lines: string[] = [];
    const badges: string[] = [];
    for (const pipe of this.pipes) {
      const points = parsePath(pipe.mapPath);
      if (points.length < 2) continue;
      const pointList = points.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ");
      const level = pipe.level ?? "ok";
      const title = escapeXml(this.text("mapPipeTitle", [pipe.startPoint, pipe.endPoint, this.levelText(level)]));
      if (dry.has(pipe.pipeID)) shadows.push(`<polyline class="marenDry" points="${pointList}"/>`);
      lines.push(
        `<polyline class="marenPipe marenPipe--${escapeXml(level)}" data-pipe="${escapeXml(pipe.pipeID)}" points="${pointList}"><title>${title}</title></polyline>`,
      );
      if (pipe.visitOrder !== null) {
        const mid = points[Math.floor(points.length / 2)];
        badges.push(
          `<g class="marenBadge" data-pipe="${escapeXml(pipe.pipeID)}"><circle cx="${mid.x.toFixed(0)}" cy="${mid.y.toFixed(0)}" r="44"/>` +
            `<text x="${mid.x.toFixed(0)}" y="${(mid.y + 20).toFixed(0)}" text-anchor="middle">${pipe.visitOrder}</text></g>`,
        );
      }
    }

    const alt = escapeXml(this.text("mapAlt"));
    this.viewModel().setProperty(
      "/mapSvg",
      `<div class="marenMap"><svg viewBox="0 0 ${MAP.width} ${MAP.height}" role="img" aria-label="${alt}">` +
        `<image href="${escapeXml(mapUrl)}" width="${MAP.width}" height="${MAP.height}"/>` +
        shadows.join("") + lines.join("") + badges.join("") +
        `</svg></div>`,
    );
    this.viewModel().setProperty("/dryText", selected ? this.dryText(selected) : "");
  }

  private dryText(pipe: RoundPipe): string {
    if (pipe.nobodyDependsOnIt || !pipe.servedAreas) return this.text("dryNobody", [pipe.startPoint, pipe.endPoint]);
    if (pipe.households !== null) {
      return this.text("drySelectedHouseholds", [pipe.startPoint, pipe.endPoint, pipe.servedAreas, pipe.households]);
    }
    return this.text("drySelected", [pipe.startPoint, pipe.endPoint, pipe.servedAreas]);
  }
}
