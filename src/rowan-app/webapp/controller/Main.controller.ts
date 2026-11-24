import Log from "sap/base/Log";
import MessageBox from "sap/m/MessageBox";
import Table from "sap/m/Table";
import type List from "sap/m/List";
import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";

/** View state: the council's budget, the proposal's total, and what the ticked rows would cost. */
interface BudgetState {
  budget: number;
  chosen: number;
  remaining: number;
  /** How many chosen rows rest on a number that may not be true (one of Ilse's signs). */
  doubtfulChosen: number;
  /** What the proposal spends, and what it leaves of the budget. */
  proposalSpent: number;
  proposalLeft: number;
}

/** The fields of a ProposalLines row the controller needs. */
interface ProposalRow {
  kind?: string;
  ref?: string;
  title?: string;
  status?: string;
  cost?: number | string;
}

/**
 * Rowan's Monday overview: on top the proposal ("als u onze 500 kronen had, gaat het hierheen, en
 * waarom"), below the tables to tick what the council really wants to pay for — the council decides.
 *
 * @namespace oakhaven.rowan.controller
 */
export default class Main extends Controller {
  private readonly state = new JSONModel({
    budget: 0,
    chosen: 0,
    remaining: 0,
    doubtfulChosen: 0,
    proposalSpent: 0,
    proposalLeft: 0,
  } satisfies BudgetState);

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
      this.onProposalUpdated();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      Log.error("Could not load the week budget", message, "oakhaven.rowan");
      MessageBox.error(message);
    }
  }

  /** The proposal has (re)loaded: show what it spends and what is left. */
  public onProposalUpdated(): void {
    const spent = this.proposalRows()
      .filter((row) => row.status === "proposed")
      .reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
    const budget = Number(this.state.getProperty("/budget")) || 0;
    this.state.setProperty("/proposalSpent", spent);
    this.state.setProperty("/proposalLeft", budget - spent);
  }

  /**
   * Ticks exactly the proposed lines in the pipes and food tables, so the budget box shows the
   * proposal. Rowan: "Wij beslissen uiteindelijk zelf" — the council can untick or add rows after.
   */
  public onTakeProposal(): void {
    const proposed = this.proposalRows().filter((row) => row.status === "proposed");
    // Compare on a property each table binds (UI5 only loads the bound ones): the pipe table shows
    // pipeID (= the line's ref), the food table shows the product name (= the line's title).
    const pick = (kind: string, field: "ref" | "title"): Set<string> =>
      new Set(proposed.filter((row) => row.kind === kind).map((row) => row[field] ?? ""));
    this.selectRows("pipesTable", "pipeID", pick("water", "ref"));
    this.selectRows("foodTable", "name", pick("food", "title"));
    this.recalculate();
  }

  /** A row was (un)ticked in the pipes or food table. */
  public onSelectionChange(): void {
    this.recalculate();
  }

  private selectRows(tableId: string, keyProperty: string, keys: Set<string>): void {
    const table = this.byId(tableId) as Table | undefined;
    if (!table) return;
    table.removeSelections(true);
    for (const item of table.getItems()) {
      const key = item.getBindingContext()?.getProperty(keyProperty) as string | undefined;
      if (key !== undefined && keys.has(key)) table.setSelectedItem(item as never, true);
    }
  }

  private proposalRows(): ProposalRow[] {
    const list = this.byId("proposalList") as List | undefined;
    const binding = list?.getBinding("items") as ODataListBinding | undefined;
    return binding ? binding.getCurrentContexts().map((context) => context.getObject() as ProposalRow) : [];
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
    this.state.setProperty("/chosen", chosen);
    this.state.setProperty("/remaining", budget - chosen);
    this.state.setProperty("/doubtfulChosen", doubtfulChosen);
  }
}
