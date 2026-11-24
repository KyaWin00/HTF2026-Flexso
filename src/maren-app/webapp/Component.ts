import IconPool from "sap/ui/core/IconPool";
import UIComponent from "sap/ui/core/UIComponent";
import XMLView from "sap/ui/core/mvc/XMLView";
import type Control from "sap/ui/core/Control";

/** The few browser members this component uses (the project compiles without the DOM lib). */
interface LocationLike {
  readonly hash: string;
  readonly search: string;
}
const browser = globalThis as unknown as { location: LocationLike };

/** Launchpad tile "Waterprobleem melden" (inbound "report" in manifest.json). */
const RESIDENT_HASH_PREFIX = "#WaterReport-";
/** Standalone: index.html?mode=resident */
const RESIDENT_MODE = /[?&]mode=resident(?:&|$)/;

/**
 * App for Maren Holt, de waterbeheerder, in two parts:
 * - crew (view Main): Maren's morning round;
 * - residents (view Resident): villagers report a water problem at their place. They never see the crew's planning.
 * Both launchpad tiles open this same component; createContent() picks the root view from the URL.
 * Models and i18n are declared in manifest.json.
 *
 * @namespace oakhaven.maren
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
    super.init();
  }

  /** Root view: the resident form for the "WaterReport" tile or ?mode=resident, otherwise the morning round. */
  public createContent(): Promise<Control> {
    const { hash, search } = browser.location;
    const resident = hash.startsWith(RESIDENT_HASH_PREFIX) || RESIDENT_MODE.test(search);
    return XMLView.create({
      id: this.createId(resident ? "resident" : "main"),
      viewName: resident ? "oakhaven.maren.view.Resident" : "oakhaven.maren.view.Main",
    });
  }
}
