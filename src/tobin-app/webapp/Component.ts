import Formatting from "sap/base/i18n/Formatting";
import IconPool from "sap/ui/core/IconPool";
import UIComponent from "sap/ui/core/UIComponent";

/**
 * App for Tobin Reyes, de bakker. Models, root view and i18n are declared in manifest.json.
 *
 * @namespace oakhaven.tobin
 */
export default class Component extends UIComponent {
  public static metadata = {
    manifest: "json",
    interfaces: ["sap.ui.core.IAsyncContentCreation"],
  };

  public init(): void {
    // Tabler Icons (served by srv/lib/icon-fonts.ts): use them as `sap-icon://ti/<name>`.
    IconPool.registerFont({
      fontFamily: "tabler-icons",
      fontURI: "/vendor/tabler-icons/",
      collectionName: "ti",
      lazy: true,
    });
    // Tobin reads Dutch: dates and numbers in Dutch ("woensdag 25 november", "1,5"), also when the
    // launchpad runs in another browser language. Must happen before the views are created.
    Formatting.setLanguageTag("nl");
    super.init();
  }
}
