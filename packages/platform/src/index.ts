export type PlatformKind = "web" | "android" | "ios" | "harmony" | "glass";

/** Future: Appium / XCUITest / HDC / Glass runtimes implement this contract. */
export type PlatformCapability = {
  platform: PlatformKind;
  available: boolean;
  label: string;
};

export const PLATFORM_ROADMAP: PlatformCapability[] = [
  { platform: "web", available: true, label: "Web (Playwright)" },
  { platform: "android", available: false, label: "Android (Appium)" },
  { platform: "ios", available: false, label: "iOS (XCUITest)" },
  { platform: "harmony", available: false, label: "HarmonyOS (HDC)" },
  { platform: "glass", available: false, label: "Glass AR" },
];
