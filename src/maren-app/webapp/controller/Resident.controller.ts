import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Log from "sap/base/Log";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import type List from "sap/m/List";
import type { ListBase$SelectionChangeEvent } from "sap/m/ListBase";
import type { TextArea$LiveChangeEvent } from "sap/m/TextArea";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";
import buildPipePlan, { type PlanPipe } from "../model/PipePlan";

/** Same limit as the server (srv/water-supply-service.ts): longer notes are refused. */
const NOTE_MAX_LENGTH = 500;

/** View state of the form (model "view"). */
interface ReportState {
  areaId: string;
  placeName: string;
  problem: string;
  note: string;
  noteTooLong: boolean;
  busy: boolean;
  planSvg: string;
}

function emptyState(planSvg = "<div></div>"): ReportState {
  return { areaId: "", placeName: "", problem: "", note: "", noteTooLong: false, busy: false, planSvg };
}

/** The few browser DOM members this controller uses (the project compiles without the DOM lib). */
interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
}
interface DomEventLike {
  target: unknown;
  key?: string;
  preventDefault?(): void;
}

/**
 * Resident part of the water app: a villager taps their place on the pipe plan and tells Maren what
 * is wrong with the water there. Calls the unbound action WaterSupplyService.reportProblem.
 * Residents never see Maren's planning: their plan has no levels, no numbered stops.
 *
 * @namespace oakhaven.maren.controller
 */
export default class Resident extends Controller {
  private bundle?: ResourceBundle;
  private pipes: PlanPipe[] = [];
  /** Place name → Landmark ID, only places that get their water through a pipe. */
  private places = new Map<string, string>();

  private readonly onPlanTap = (event: DomEventLike): void => {
    if (event.key !== undefined && event.key !== "Enter" && event.key !== " ") return;
    const name = (event.target as ElementLike | null)?.closest("[data-place]")?.getAttribute("data-place");
    if (!name) return;
    event.preventDefault?.();
    this.choosePlace(name);
  };

  public onInit(): void {
    this.getView()?.setModel(new JSONModel(emptyState()), "view");
    // Taps (and Enter/Space) on a place of the plan. The plan is plain SVG inside core:HTML, so UI5
    // routes its events to the nearest real control above it; listening on the view catches them all.
    this.getView()?.addEventDelegate({ onclick: this.onPlanTap, onkeydown: this.onPlanTap }, this);
    void this.loadPlan();
  }

  /** A problem was tapped: its code sits in the item's custom data (app:problem in the view). */
  public onProblemSelect(event: ListBase$SelectionChangeEvent): void {
    const code: unknown = event.getParameter("listItem")?.data("problem");
    this.state().setProperty("/problem", typeof code === "string" ? code : "");
  }

  public onNoteChange(event: TextArea$LiveChangeEvent): void {
    const value = event.getParameter("value") ?? "";
    this.state().setProperty("/noteTooLong", value.length > NOTE_MAX_LENGTH);
  }

  public onSend(): void {
    void this.send();
  }

  /** Reads the pipes and the places that can be reported from, then draws the plan. */
  private async loadPlan(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    const i18n = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
    if (!model) return;
    try {
      this.bundle = (await i18n?.getResourceBundle()) ?? undefined;
      const [pipes, places] = await Promise.all([
        model
          .bindList("/MorningRound", undefined, [], [], { $select: "pipeID,startPoint,endPoint,downstreamPipes" })
          .requestContexts(0, 100),
        model
          .bindList("/Landmarks", undefined, [], [new Filter("suppliedBy", FilterOperator.NE, null)], { $select: "ID,name" })
          .requestContexts(0, 100),
      ]);
      this.pipes = pipes.map((context) => context.getObject() as PlanPipe);
      this.places = new Map(places.map((context) => [String(context.getProperty("name")), String(context.getProperty("ID"))]));
      this.drawPlan();
    } catch (error: unknown) {
      Log.warning("Could not load the pipe plan", String(error), "oakhaven.maren.Resident");
    }
  }

  private drawPlan(): void {
    this.state().setProperty(
      "/planSvg",
      buildPipePlan(this.pipes, {
        showStatus: false,
        selectablePlaces: new Set(this.places.keys()),
        selectedPlace: this.state().getProperty("/placeName") as string,
        text: (key, args) => this.bundle?.getText(key, args) ?? key,
      }),
    );
  }

  private choosePlace(name: string): void {
    const id = this.places.get(name);
    if (!id) return;
    this.state().setProperty("/areaId", id);
    this.state().setProperty("/placeName", name);
    this.drawPlan();
  }

  /** Invokes /reportProblem(...) with the chosen place, problem and note. */
  private async send(): Promise<void> {
    const model = this.getOwnerComponent()?.getModel() as ODataModel | undefined;
    if (!model) return;
    const state = this.state().getData() as ReportState;

    this.state().setProperty("/busy", true);
    const action = model.bindContext("/reportProblem(...)");
    action
      .setParameter("area_ID", state.areaId)
      .setParameter("problem", state.problem)
      .setParameter("note", state.note.trim());
    try {
      await action.invoke();
      MessageToast.show(this.text("reportThanks"));
      this.reset();
    } catch (error: unknown) {
      Log.warning("reportProblem failed", String(error), "oakhaven.maren.Resident");
      // The V4 model puts the server's message text into error.message.
      const message = error instanceof Error && error.message ? error.message : this.text("reportFailed");
      MessageBox.error(message);
    } finally {
      this.state().setProperty("/busy", false);
      action.destroy();
    }
  }

  /** Empty form again, ready for the next report. */
  private reset(): void {
    this.state().setData(emptyState());
    (this.byId("problemList") as List | undefined)?.removeSelections(true);
    this.drawPlan();
  }

  private state(): JSONModel {
    return this.getView()?.getModel("view") as JSONModel;
  }

  private text(key: string): string {
    return this.bundle?.getText(key) ?? key;
  }
}
