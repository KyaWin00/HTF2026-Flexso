import Log from "sap/base/Log";
import MessageBox from "sap/m/MessageBox";
import Table from "sap/m/Table";
import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";

/** View state: the council's budget and what the chosen rows would cost. */
interface BudgetState {
  budget: number;
  chosen: number;
  remaining: number;
  /** How many chosen rows rest on a number that may not be true (one of Ilse's signs). */
  doubtfulChosen: number;
}

/**
 * Rowan's Monday overview: tick what the council wants to pay for, see what is left of the
 * weekly budget, and see when a choice rests on a number that may not be true.
 *
 * @namespace oakhaven.rowan.controller
 */
export default class Main extends Controller {
  private readonly state = new JSONModel({ budget: 0, chosen: 0, remaining: 0, doubtfulChosen: 0 } satisfies BudgetState);

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
      this.recalculate();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Log.error("Could not load the week budget", message, "oakhaven.rowan");
      MessageBox.error(message);
    }
  }

  /** A row was (un)ticked in the pipes or food table. */
  public onSelectionChange(): void {
    this.recalculate();
  }

  private recalculate(): void {
    const contexts = ["pipesTable", "foodTable"].flatMap((id) => {
      const table = this.byId(id) as Table | undefined;
      return table ? table.getSelectedContexts() : [];
    });
    let chosen = 0;
    let doubtfulChosen = 0;
    for (const context of contexts) {
      chosen += Number(context.getProperty("cost")) || 0;
      if (context.getProperty("doubtful") === true) doubtfulChosen += 1;
    }
    const budget = Number(this.state.getProperty("/budget")) || 0;
    this.state.setData({ budget, chosen, remaining: budget - chosen, doubtfulChosen } satisfies BudgetState);
  }
}
