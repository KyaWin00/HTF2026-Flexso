import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Log from "sap/base/Log";
import NumberFormat from "sap/ui/core/format/NumberFormat";
import type Select from "sap/m/Select";
import type Context from "sap/ui/model/odata/v4/Context";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import type ResourceModel from "sap/ui/model/resource/ResourceModel";
import type ResourceBundle from "sap/base/i18n/ResourceBundle";

/** What FoodStockService.recordDelivery returns (Decimals may arrive as strings). */
interface DeliveryResult {
  stockUpdated?: boolean;
  newQuantity?: number | string | null;
}

/** The form's own state (view model "form"). */
interface FormState {
  quantity: string;
  supplier: string;
  receivedAt: Date;
  now: Date;
  unit: string;
  unitText: string;
  currentText: string;
  impossible: boolean;
  busy: boolean;
}

/**
 * Tobin notes a delivery: "welk product, hoeveel, van wie en wanneer". The product list and the
 * history are bound to FoodStockService; the form is plain view state until he saves, then the
 * bound action StockItems/recordDelivery does the work (rules in srv/food-stock-service.ts).
 *
 * @namespace oakhaven.tobindelivery.controller
 */
export default class Delivery extends Controller {
  public onInit(): void {
    this.getView()?.setModel(new JSONModel(this.emptyForm()), "form");
  }

  /** A product was chosen: fill in its usual supplier, unit and what is in the pantry now. */
  public async onProductChange(): Promise<void> {
    const context = this.selectedContext();
    if (!context) return;
    const [supplier, unit, current] = (await Promise.all([
      context.requestProperty("supplier"),
      context.requestProperty("unit"),
      context.requestProperty("currentQuantity"),
    ])) as [unknown, unknown, unknown];
    const bundle = await this.getBundle();
    const unitCode = typeof unit === "string" ? unit : "";
    const currentNumber = Number(current);
    const form = this.getForm();
    form.setProperty("/supplier", typeof supplier === "string" ? supplier : "");
    form.setProperty("/unit", unitCode);
    form.setProperty("/unitText", this.unitText(unitCode, bundle));
    form.setProperty("/currentText", Number.isFinite(currentNumber) ? this.amount(currentNumber, unitCode, bundle) : "");
    form.setProperty("/impossible", Number.isFinite(currentNumber) && currentNumber < 0);
  }

  /** Saves the delivery through the bound action, then refreshes the history and the stock. */
  public async onSave(): Promise<void> {
    const bundle = await this.getBundle();
    const context = this.selectedContext();
    if (!context) {
      MessageBox.warning(bundle.getText("chooseProduct") ?? "");
      return;
    }
    const form = this.getForm();
    const state = form.getData() as FormState;
    const model = this.getOwnerComponent()?.getModel("food") as ODataModel;
    const action = model.bindContext("FoodStockService.recordDelivery(...)", context);
    action.setParameter("quantity", String(state.quantity ?? "").replace(",", "."));
    action.setParameter("supplier", state.supplier);
    // CDS DateTime has seconds precision: drop the milliseconds.
    action.setParameter("receivedAt", state.receivedAt.toISOString().replace(/\.\d{3}Z$/, "Z"));

    form.setProperty("/busy", true);
    try {
      await action.invoke();
      const result = (action.getBoundContext().getObject() ?? {}) as DeliveryResult;
      const product = this.selectedProductName();
      const delivered = this.amount(Number(state.quantity.replace(",", ".")), state.unit, bundle);
      const message = result.stockUpdated
        ? bundle.getText("savedUpdated", [delivered, product, this.amount(Number(result.newQuantity), state.unit, bundle)])
        : bundle.getText("savedNotUpdated", [delivered, product]);
      MessageToast.show(message ?? "");
      model.refresh();
      form.setData(this.emptyForm());
      (this.byId("productSelect") as Select | undefined)?.setSelectedKey("");
    } catch (error) {
      // The server's own message ("Een levering kan niet in de toekomst binnenkomen …").
      const text = error instanceof Error ? error.message : (bundle.getText("saveError") ?? "");
      Log.error("recordDelivery failed", text, "oakhaven.tobindelivery");
      MessageBox.error(text);
    } finally {
      form.setProperty("/busy", false);
    }
  }

  private emptyForm(): FormState {
    const now = new Date();
    return {
      quantity: "",
      supplier: "",
      receivedAt: now,
      now,
      unit: "",
      unitText: "",
      currentText: "",
      impossible: false,
      busy: false,
    };
  }

  private selectedContext(): Context | undefined {
    const select = this.byId("productSelect") as Select | undefined;
    return (select?.getSelectedItem()?.getBindingContext("food") ?? undefined) as Context | undefined;
  }

  /** The product as shown in the dropdown (Dutch name for the bakery ingredients). */
  private selectedProductName(): string {
    const select = this.byId("productSelect") as Select | undefined;
    return (select?.getSelectedItem()?.getText() ?? "").toLocaleLowerCase();
  }

  /** "20 kg", "120 liter", "5 Dozen" — Dutch number format, unit texts from i18n. */
  private amount(quantity: number, unit: string, bundle: ResourceBundle): string {
    if (!Number.isFinite(quantity)) return "";
    const number = NumberFormat.getFloatInstance({ maxFractionDigits: 2 }).format(quantity);
    return `${number} ${this.unitText(unit, bundle)}`.trim();
  }

  private unitText(unit: string, bundle: ResourceBundle): string {
    if (unit === "KG") return bundle.getText("unitKG") ?? unit;
    if (unit === "L") return bundle.getText("unitL") ?? unit;
    return unit;
  }

  private getForm(): JSONModel {
    return this.getView()?.getModel("form") as JSONModel;
  }

  private async getBundle(): Promise<ResourceBundle> {
    const i18n = this.getOwnerComponent()?.getModel("i18n") as ResourceModel;
    return await i18n.getResourceBundle();
  }
}
