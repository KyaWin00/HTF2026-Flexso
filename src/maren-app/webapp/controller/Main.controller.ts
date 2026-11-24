import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import DateFormat from "sap/ui/core/format/DateFormat";
import Locale from "sap/ui/core/Locale";
import Device from "sap/ui/Device";
import Log from "sap/base/Log";
import Formatting from "sap/base/i18n/Formatting";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";
import type ListBase from "sap/m/ListBase";
import type { ListBase$UpdateFinishedEvent } from "sap/m/ListBase";
import type { ListItemBase$PressEvent } from "sap/m/ListItemBase";
import type Context from "sap/ui/model/odata/v4/Context";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type ManagedObject from "sap/ui/base/ManagedObject";
import type UI5Event from "sap/ui/base/Event";
import type VBox from "sap/m/VBox";
import type { Button$PressEvent } from "sap/m/Button";
import type Button from "sap/m/Button";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import buildPipePlan from "../model/PipePlan";

/** One of today's stops as the read-aloud text needs it. */
interface StopData {
  visitOrder: number | null;
  endPoint: string;
  level: string | null;
  flowPercent: number | null;
  households: number | null;
  nobodyDependsOnIt: boolean | null;
  whyBeforeNext: string | null;
}

/** i18n keys of the "why" codes (srv/lib/morning-round.ts WhyCode) and of Ilse's doubt signs. */
const WHY_KEYS: Readonly<Record<string, string>> = {
  alarmFirst: "whyAlarmFirst",
  areaOrder: "whyAreaOrder",
  upstream: "whyUpstream",
  peopleFirst: "whyPeopleFirst",
  nobody: "whyNobody",
  last: "whyLast",
};
const DOUBT_KEYS: Readonly<Record<string, string>> = {
  meterTooHigh: "doubtMeterTooHigh",
  changedBySystem: "doubtChangedBySystem",
  changedAtNight: "doubtChangedAtNight",
  futureDate: "doubtFutureDate",
};

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
/** The browser's own speech (Web Speech API): no package, works offline with the phone's voices. */
interface UtteranceLike {
  lang: string;
  rate: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
interface SpeechLike {
  readonly speaking: boolean;
  speak(utterance: UtteranceLike): void;
  cancel(): void;
}
const browser = globalThis as unknown as {
  document: DocumentLike;
  navigator: WakeLockNavigator;
  speechSynthesis?: SpeechLike;
  SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
};

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
  private todayPlaces: string[] = [];
  private roundBinding?: ODataListBinding;
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
    // Dutch dates and numbers, also inside the launchpad (which follows the browser language).
    Formatting.setLanguageTag("nl");
    const range = Device.media.getCurrentRange(Device.media.RANGESETS.SAP_STANDARD);
    this.getView()?.setModel(
      new JSONModel({
        todayText: this.todayText(),
        refreshedText: this.timeText(),
        wide: WIDE_RANGES.has(range?.name ?? ""),
        mapSvg: "<div></div>",
        planSvg: "<div></div>",
        dryText: "",
        noStops: false,
        noLater: false,
        textsReady: false,
        canSpeak: !!browser.speechSynthesis && !!browser.SpeechSynthesisUtterance,
        speaking: false,
        summary: "",
      }),
      "view",
    );
    Device.media.attachHandler(this.onRangeChange, this, Device.media.RANGESETS.SAP_STANDARD);
    // Wet gloves: one tap anywhere on today's stops reads them aloud (tap again to stop).
    // (Not when the tap is on a button inside a stop, such as "Hersteld".)
    this.byId("todayList")?.addEventDelegate(
      {
        onclick: (event: { target: unknown }) => {
          if (!(event.target as ElementLike | null)?.closest(".sapMBtn")) this.readAloud();
        },
      },
      this,
    );
    // A click on a pipe of the plan or the map shows its dry shadow. Both are plain SVG inside
    // core:HTML, so UI5 routes their events to the nearest real control above; the view catches them.
    this.getView()?.addEventDelegate({ onclick: this.onMapClick }, this);

    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    browser.document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.keepScreenOn();
    void this.loadTexts();
    void this.loadRound();
  }

  public onExit(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    browser.document.removeEventListener("visibilitychange", this.onVisibilityChange);
    Device.media.detachHandler(this.onRangeChange, this, Device.media.RANGESETS.SAP_STANDARD);
    void this.wakeLock?.release();
    browser.speechSynthesis?.cancel();
  }

  /** The visits for later days have (re)loaded: say so when there are none. */
  public onLaterChange(event: UI5Event): void {
    const binding = event.getSource() as ODataListBinding;
    this.viewModel().setProperty("/noLater", binding.isLengthFinal() && binding.getLength() === 0);
  }

  /** Maren marks a villager's report as dealt with (bound action markHandled). */
  public async onMarkHandled(event: Button$PressEvent): Promise<void> {
    const button = event.getSource();
    const context = button.getBindingContext() as Context | undefined;
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!context || !model) return;
    button.setBusy(true);
    try {
      await model.bindContext("WaterSupplyService.markHandled(...)", context).invoke();
      MessageToast.show(this.text("reportHandledToast"));
      this.refresh(true);
    } catch (error) {
      MessageBox.error(error instanceof Error ? error.message : String(error));
    } finally {
      button.setBusy(false);
    }
  }

  /** The water bar of a stop: how much of the normal water is left, with the text inside the bar. */
  public waterBar(percent: number | null, level: string | null, _textsReady: boolean): string {
    const value = Math.min(Math.max(Math.round(percent ?? 0), 0), 100);
    const text = escapeXml(this.text("stopWaterLeft", [value]));
    const kind = level === "alarm" ? "alarm" : "attention";
    return (
      `<div class="marenBar marenBar--${kind}" role="img" aria-label="${text}">` +
      `<div class="marenBarFill" style="width:${value}%"></div>` +
      `<span class="marenBarText">${text}</span></div>`
    );
  }

  /** "Hersteld": asks once, then marks the pipe as repaired; it leaves today's list. */
  public onMarkRepaired(event: Button$PressEvent): void {
    const button = event.getSource();
    const context = button.getBindingContext() as Context | undefined;
    const pipeId = context?.getProperty("ID") as string | undefined;
    const place = String(context?.getProperty("endPoint") ?? "");
    if (!pipeId) return;
    const yes = this.text("repairYes");
    MessageBox.confirm(this.text("repairConfirm", [place]), {
      title: this.text("repairTitle"),
      actions: [yes, this.text("repairNo")],
      emphasizedAction: yes,
      onClose: (action: unknown) => {
        if (action === yes) void this.markRepaired(pipeId, place, button);
      },
    });
  }

  /** A repair dated after now cannot be true (one of Ilse's signs). */
  public isFuture(date: string | null): boolean {
    return !!date && new Date(date).getTime() > Date.now();
  }

  private async markRepaired(pipeId: string, place: string, button: Button): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!model) return;
    button.setBusy(true);
    const action = model.bindContext("/markRepaired(...)");
    action.setParameter("pipe_ID", pipeId);
    try {
      await action.invoke();
      MessageToast.show(this.text("repairDone", [place]));
      this.refresh(true);
    } catch (error) {
      MessageBox.error(error instanceof Error ? error.message : String(error));
    } finally {
      button.setBusy(false);
      action.destroy();
    }
  }

  /** Ilse's doubt signs (codes from the server) as readable text. */
  public formatDoubt(signs: string | null, _textsReady: boolean): string {
    return (signs ?? "")
      .split(",")
      .filter(Boolean)
      .map((sign) => this.text(DOUBT_KEYS[sign] ?? sign))
      .join(", ");
  }

  /** Today's stops have (re)loaded: show the "niets te herstellen" card only when there are none. */
  public onStopsChange(event: UI5Event): void {
    const binding = event.getSource() as ODataListBinding;
    this.todayPlaces = binding.getAllCurrentContexts().map((context) => String(context.getProperty("endPoint") ?? ""));
    this.updateSummary();
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
  /** Reads the whole round (all pipes) for the plan and the map — also on the phone. */
  private async loadRound(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!model) return;
    this.roundBinding ??= model.bindList("/MorningRound", undefined, [], [], {
      $select: "pipeID,startPoint,endPoint,mapPath,downstreamPipes,servedAreas,households,level,visitOrder,nobodyDependsOnIt",
    });
    try {
      const contexts = await this.roundBinding.requestContexts(0, 100);
      this.pipes = contexts.map((context) => context.getObject() as RoundPipe);
      this.drawMap();
    } catch (error) {
      Log.warning("Could not read the morning round", String(error), "oakhaven.maren");
    }
  }

  private viewModel(): JSONModel {
    return this.getView()?.getModel("view") as JSONModel;
  }

  private async loadTexts(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
    this.bundle = (await model?.getResourceBundle()) ?? undefined;
    this.viewModel().setProperty("/textsReady", true);
    this.updateSummary();
    this.drawMap();
  }

  /** The one sentence the home screen answers: what do we do today? */
  private updateSummary(): void {
    if (!this.bundle) return;
    const [first, second] = this.todayPlaces;
    this.viewModel().setProperty(
      "/summary",
      second ? this.text("summaryTwo", [first, second]) : first ? this.text("summaryOne", [first]) : this.text("summaryNone"),
    );
  }

  /** The "Voorlezen" button: reads today's stops aloud, or stops when it is already speaking. */
  public onReadAloud(): void {
    this.readAloud();
  }

  /** Reads today's stops aloud with the phone's own voice; a second tap stops it. */
  private readAloud(): void {
    const speech = browser.speechSynthesis;
    const Utterance = browser.SpeechSynthesisUtterance;
    if (!speech || !Utterance || !this.bundle) return;
    if (speech.speaking) {
      speech.cancel();
      this.viewModel().setProperty("/speaking", false);
      return;
    }
    const stops = ((this.byId("todayList") as VBox | undefined)?.getItems() ?? [])
      .map((item) => item.getBindingContext()?.getObject() as StopData | undefined)
      .filter((stop): stop is StopData => !!stop);
    const sentences = stops.map((stop) =>
      this.text("speakStop", [
        this.text(stop.visitOrder === 1 ? "stopFirst" : "stopNext"),
        stop.endPoint,
        this.levelText(stop.level),
        stop.flowPercent ?? 0,
        this.text(WHY_KEYS[stop.whyBeforeNext ?? "last"] ?? "whyLast"),
      ]),
    );
    const utterance = new Utterance(sentences.length > 0 ? sentences.join(" ") : this.text("speakNone"));
    utterance.lang = "nl-NL";
    utterance.rate = 0.95;
    utterance.onend = () => this.viewModel().setProperty("/speaking", false);
    utterance.onerror = () => this.viewModel().setProperty("/speaking", false);
    speech.cancel();
    speech.speak(utterance);
    this.viewModel().setProperty("/speaking", true);
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
  private refresh(all = false): void {
    const wide = all || this.viewModel().getProperty("/wide") === true;
    const lists = ["todayList", "laterList", "reportList", "historyList"];
    for (const id of wide ? [...lists, "roundTable"] : lists) {
      (this.byId(id) as ManagedObject | undefined)?.getBinding("items")?.refresh();
    }
    void this.loadRound();
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
    this.drawPlan();
    const selected = this.pipes.find((p) => p.pipeID === this.selectedPipe);
    // Nothing selected: show who is without enough water right now — everything behind a pipe in
    // alarm that people depend on ("valt een leiding uit, dan zit iedereen erachter ook zonder").
    const inAlarm = this.pipes.filter((p) => p.level === "alarm" && !p.nobodyDependsOnIt);
    const sources = selected ? [selected] : inAlarm;
    const dry = new Set(sources.flatMap((p) => (p.downstreamPipes ?? "").split(",")).filter(Boolean));
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
      if (dry.has(pipe.pipeID)) {
        const end = points[points.length - 1];
        shadows.push(
          `<polyline class="marenDry" points="${pointList}"/>` +
            `<text class="marenDryLabel" x="${end.x.toFixed(0)}" y="${(end.y - 50).toFixed(0)}" text-anchor="middle">${escapeXml(this.text("dryLabel"))}</text>`,
        );
      }
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
    const dryNow = [...new Set(inAlarm.flatMap((p) => (p.servedAreas ?? "").split(", ").filter(Boolean)))];
    this.viewModel().setProperty(
      "/dryText",
      selected ? this.dryText(selected) : dryNow.length > 0 ? this.text("dryNow", [dryNow.join(", ")]) : "",
    );
  }

  private dryText(pipe: RoundPipe): string {
    if (pipe.nobodyDependsOnIt || !pipe.servedAreas) return this.text("dryNobody", [pipe.startPoint, pipe.endPoint]);
    if (pipe.households !== null) {
      return this.text("drySelectedHouseholds", [pipe.startPoint, pipe.endPoint, pipe.servedAreas, pipe.households]);
    }
    return this.text("drySelected", [pipe.startPoint, pipe.endPoint, pipe.servedAreas]);
  }

  /** The pipe plan (model/PipePlan.ts), crew version: levels, today's numbered dots, dry shadow. */
  private drawPlan(): void {
    const selected = this.pipes.find((p) => p.pipeID === this.selectedPipe);
    const sources = selected ? [selected] : this.pipes.filter((p) => p.level === "alarm" && !p.nobodyDependsOnIt);
    const dry = new Set(sources.flatMap((p) => (p.downstreamPipes ?? "").split(",")).filter(Boolean));
    this.viewModel().setProperty(
      "/planSvg",
      buildPipePlan(this.pipes, {
        showStatus: true,
        dry,
        text: (key, args) => this.text(key, args),
        levelText: (level) => this.levelText(level),
      }),
    );
  }
}
