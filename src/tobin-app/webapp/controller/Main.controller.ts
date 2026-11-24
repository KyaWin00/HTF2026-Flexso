import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import Log from "sap/base/Log";
import DateFormat from "sap/ui/core/format/DateFormat";
import { ValueState } from "sap/ui/core/library";
import type List from "sap/m/List";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";
import type Event from "sap/ui/base/Event";
import formatter, { type Advice } from "../model/formatter";

/** The fields of a BakeryWeek row the morning message needs (all bound in Main.view.xml). */
interface IngredientRow {
  itemID?: string;
  name?: string;
  advice?: Advice | null;
  latestOrderDate?: string | null;
  belowComfortNow?: boolean | null;
}

/** One line of the morning message: text + icon + semantic state (never colour alone). */
interface MessageLine {
  text: string;
  icon: string;
  state: ValueState;
}

/** Parameters of the list binding's `dataReceived` event. */
interface DataReceivedParameters {
  error?: { message?: string };
}

/**
 * Tobin's bakery week. The ingredient cards are bound straight to FoodStockService.BakeryWeek
 * (all rules run on the server, srv/lib/bakery-week.ts). This controller only writes the 5 am
 * message at the top, from the same rows, into the "view" model.
 *
 * @namespace oakhaven.tobin.controller
 */
export default class Main extends Controller {
  public onInit(): void {
    const viewModel = new JSONModel({
      busy: true,
      today: new Date(),
      headline: "",
      lines: [],
    });
    this.getView()?.setModel(viewModel, "view");
  }

  /** Errors while loading: stop the busy indicator and show the server's message. */
  public onDataReceived(event: Event<DataReceivedParameters>): void {
    const error = event.getParameter("error");
    if (!error) return;
    void this.showNoMessage();
    Log.error("BakeryWeek could not be loaded", error.message, "oakhaven.tobin");
    const bundle = this.getBundleIfLoaded();
    MessageBox.error(error.message ?? bundle?.getText("loadError") ?? "");
  }

  /** The ingredient list has (re)loaded: write the morning message from its rows. */
  public async onIngredientsUpdated(): Promise<void> {
    const list = this.byId("ingredientList") as List | undefined;
    const binding = list?.getBinding("items") as ODataListBinding | undefined;
    if (!binding) return;
    const rows = binding.getCurrentContexts().map((context) => context.getObject() as IngredientRow);
    if (rows.length === 0) {
      // No rows (no data, or loading failed): never reassure Tobin without data.
      await this.showNoMessage();
      return;
    }
    const bundle = await this.getBundle();

    const viewModel = this.getViewModel();
    viewModel.setProperty("/headline", this.headline(rows, bundle));
    viewModel.setProperty("/lines", this.lines(rows, bundle));
    viewModel.setProperty("/busy", false);
  }

  /** The answer to "kan ik volgende week nog bakken?" in one sentence. */
  private headline(rows: IngredientRow[], bundle: ResourceBundle): string {
    const urgent = rows.some((row) => ["impossible", "late", "today", "unknown"].includes(row.advice ?? "unknown"));
    if (urgent) return bundle.getText("messageActNow") ?? "";
    if (rows.some((row) => row.advice === "soon")) return bundle.getText("messageOnlySoon") ?? "";
    return bundle.getText("messageAllGood") ?? "";
  }

  /** What to do this morning, most urgent first. */
  private lines(rows: IngredientRow[], bundle: ResourceBundle): MessageLine[] {
    const named = (advices: Advice[]): string[] =>
      rows.filter((row) => advices.includes(row.advice ?? "unknown")).map((row) => this.ingredientName(row, bundle));
    const line = (key: string, args: string[], state: ValueState, icon: string): MessageLine => ({
      text: bundle.getText(key, args) ?? "",
      icon,
      state,
    });
    const result: MessageLine[] = [];

    // Order today, each ingredient named once: first the late ones (with the reason), then the rest.
    // Late: either it is already below the comfort level, or it gets there before the delivery.
    const late = rows.filter((row) => row.advice === "late");
    const alreadyBelow = late.filter((row) => row.belowComfortNow === true).map((row) => this.ingredientName(row, bundle));
    const tooLate = late.filter((row) => row.belowComfortNow !== true).map((row) => this.ingredientName(row, bundle));
    const orderToday = named(["today"]);
    if (alreadyBelow.length > 0) {
      result.push(line("lineOrderAlreadyBelow", [this.joinNames(alreadyBelow, bundle)], ValueState.Error, formatter.adviceIcon("late")));
    }
    if (tooLate.length > 0) {
      result.push(line("lineOrderTooLate", [this.joinNames(tooLate, bundle)], ValueState.Error, formatter.adviceIcon("late")));
    }
    if (orderToday.length > 0) {
      result.push(line("lineOrderToday", [this.joinNames(orderToday, bundle)], ValueState.Error, formatter.adviceIcon("today")));
    }
    const dateFormat = DateFormat.getDateInstance({ pattern: "EEEE d MMMM" });
    for (const row of rows.filter((candidate) => candidate.advice === "soon")) {
      const date = row.latestOrderDate ? dateFormat.format(new Date(`${row.latestOrderDate}T00:00:00`)) : "";
      result.push(line("lineOrderSoon", [this.ingredientName(row, bundle), date], ValueState.Warning, formatter.adviceIcon("soon")));
    }
    const countAgain = named(["impossible"]);
    if (countAgain.length > 0) {
      result.push(line("lineCountAgain", [this.joinNames(countAgain, bundle)], ValueState.Error, formatter.adviceIcon("impossible")));
    }
    const unknown = named(["unknown"]);
    if (unknown.length > 0) {
      result.push(line("lineUnknown", [this.joinNames(unknown, bundle)], ValueState.Information, formatter.adviceIcon("unknown")));
    }
    if (late.length === 0 && orderToday.length === 0) {
      result.push(line("lineNothingToday", [], ValueState.Success, formatter.adviceIcon("ok")));
    }
    return result;
  }

  /** Neutral message when there are no rows to judge: no reassurance, no advice. */
  private async showNoMessage(): Promise<void> {
    const bundle = await this.getBundle();
    const viewModel = this.getViewModel();
    viewModel.setProperty("/headline", bundle.getText("messageNoData") ?? "");
    viewModel.setProperty("/lines", []);
    viewModel.setProperty("/busy", false);
  }

  /** Dutch name of an ingredient, lower case for inside a sentence ("melk"). */
  private ingredientName(row: IngredientRow, bundle: ResourceBundle): string {
    const key = `ingredient${row.itemID ?? ""}`;
    const name = bundle.hasText(key) ? bundle.getText(key) ?? "" : row.name ?? "";
    return name.toLocaleLowerCase();
  }

  /** "bloem", "bloem en melk", "bloem, melk en boter" — the joining words come from i18n. */
  private joinNames(names: string[], bundle: ResourceBundle): string {
    if (names.length <= 1) return names[0] ?? "";
    const head = names.slice(0, -1).reduce((joined, name) => bundle.getText("listComma", [joined, name]) ?? "");
    return bundle.getText("listAnd", [head, names[names.length - 1]]) ?? "";
  }

  private getViewModel(): JSONModel {
    return this.getView()?.getModel("view") as JSONModel;
  }

  private getI18nModel(): ResourceModel {
    return this.getOwnerComponent()?.getModel("i18n") as ResourceModel;
  }

  private async getBundle(): Promise<ResourceBundle> {
    return await this.getI18nModel().getResourceBundle();
  }

  private getBundleIfLoaded(): ResourceBundle | undefined {
    const bundle = this.getI18nModel().getResourceBundle();
    return bundle instanceof Promise ? undefined : bundle;
  }
}
