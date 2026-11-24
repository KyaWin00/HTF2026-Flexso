import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Log from "sap/base/Log";
import type List from "sap/m/List";
import type { ListBase$SelectionChangeEvent } from "sap/m/ListBase";
import type { TextArea$LiveChangeEvent } from "sap/m/TextArea";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";

/** Same limit as the server (srv/water-supply-service.ts): longer notes are refused. */
const NOTE_MAX_LENGTH = 500;

/** View state of the form (model "view"). */
interface ReportState {
  areaId: string;
  problem: string;
  note: string;
  noteTooLong: boolean;
  busy: boolean;
}

function emptyState(): ReportState {
  return { areaId: "", problem: "", note: "", noteTooLong: false, busy: false };
}

/**
 * Resident part of the water app: a villager reports that something is wrong with the water at
 * their place. Calls the unbound action WaterSupplyService.reportProblem. Residents never see
 * Maren's planning: this view only reads /Landmarks.
 *
 * @namespace oakhaven.maren.controller
 */
export default class Resident extends Controller {
  public onInit(): void {
    this.getView()?.setModel(new JSONModel(emptyState()), "view");
  }

  /** A place was tapped: remember its Landmark ID (the server finds the pipe that supplies it). */
  public onPlaceSelect(event: ListBase$SelectionChangeEvent): void {
    const id: unknown = event.getParameter("listItem")?.getBindingContext()?.getProperty("ID");
    this.state().setProperty("/areaId", typeof id === "string" ? id : "");
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
      MessageToast.show(await this.text("reportThanks"));
      this.reset();
    } catch (error: unknown) {
      Log.warning("reportProblem failed", String(error), "oakhaven.maren.Resident");
      // The V4 model puts the server's message text into error.message.
      const message = error instanceof Error && error.message ? error.message : await this.text("reportFailed");
      MessageBox.error(message);
    } finally {
      this.state().setProperty("/busy", false);
      action.destroy();
    }
  }

  /** Empty form again, ready for the next report. */
  private reset(): void {
    this.state().setData(emptyState());
    (this.byId("placeList") as List | undefined)?.removeSelections(true);
    (this.byId("problemList") as List | undefined)?.removeSelections(true);
  }

  private state(): JSONModel {
    return this.getView()?.getModel("view") as JSONModel;
  }

  private async text(key: string): Promise<string> {
    const i18n = this.getOwnerComponent()?.getModel("i18n") as ResourceModel | undefined;
    const bundle = await i18n?.getResourceBundle();
    return bundle?.getText(key) ?? key;
  }
}
