using { oakhaven.curse as db } from '../db/schema';

/**
 * Food data of Oakhaven: the village pantry.
 * Served at /odata/v4/food-stock — try http://localhost:4004/odata/v4/food-stock/StockItems
 */
// `impl` points CAP at the TypeScript handler file (written without the `.ts` extension).
service FoodStockService @(path: 'food-stock', impl: 'srv/food-stock-service') {

  @readonly
  entity StockItems     as projection on db.StockItems actions {
    /**
     * Tobin notes a delivery himself: "welk product, hoeveel, van wie en wanneer" (app
     * src/tobin-delivery). Adds a StockReceivals row and raises the stock — except when the stock
     * cannot be true (negative): Tobin said that is for Ilse, so then only the delivery is noted.
     */
    action recordDelivery(quantity : Decimal(9, 2), supplier : String, receivedAt : DateTime) returns DeliveryResult;
  };

  /** What happened when a delivery was noted. */
  type DeliveryResult {
    stockUpdated : Boolean;       // false = stock left as it was (impossible value, for Ilse)
    newQuantity  : Decimal(9, 2); // the stock after the delivery
  }

  @readonly
  entity StockReceivals as projection on db.StockReceivals;

  @readonly
  entity Notifications  as projection on db.Notifications;

  /** Expected stock of one ingredient on one morning of the coming week (day 0 = today). */
  type OutlookDay {
    day      : Integer;
    date     : Date;
    quantity : Decimal(9, 2); // in `unit`, never below 0
    unit     : String;        // the item's unit (KG, L, …)
    level    : String;        // 'ok' | 'belowComfort' | 'panic' | 'empty' (DayLevel in srv/lib/bakery-week.ts)
    marketDay : Boolean;      // Saturday: flour, milk and bread go twice as fast (Tobin)
  }

  /**
   * Tobin's bakery week (app src/tobin-app): his bread ingredients (flour, milk, butter) with the
   * advice when to order, most urgent first. The rules are in srv/lib/bakery-week.ts; all virtual
   * fields are filled in by planBakeryWeek in food-stock-service.ts.
   * `cds.redirection.target: false` — StockReceivals/Notifications keep pointing to StockItems.
   */
  @readonly
  @cds.redirection.target: false
  entity BakeryWeek as projection on db.StockItems {
    ID, itemID, name, unit, icon,
    currentQuantity, minStockLevel, consumptionRate, leadTimeDays, supplier,
    virtual null as advice            : String,       // Advice in srv/lib/bakery-week.ts
    virtual null as quantityTrusted   : Boolean,      // false = impossible quantity, count first
    virtual null as daysAboveComfort  : Decimal(9, 2),// days until the comfort level is reached
    virtual null as latestOrderInDays : Integer,      // order day incl. margin: 0 = today; null = too late
    virtual null as latestOrderDate   : Date,         // order date incl. margin; null when too late or unknown
    virtual null as belowComfortNow   : Boolean,
    virtual null as belowComfortDate  : Date,         // first morning below the comfort level
    virtual null as orderBelowQuantity : Decimal(9, 2),// below this quantity: order today ("tel na")
    virtual null as orderQuantity     : Decimal(9, 2),// how much: comfort level + a week of use at delivery
    virtual null as panicBeforeDelivery : Boolean,    // below half the comfort level before the delivery
    virtual null as outlook           : many OutlookDay // today + 6 days, without new deliveries
  } where forBread = true;
}
