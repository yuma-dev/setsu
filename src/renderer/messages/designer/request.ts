import { useEffect } from "react";
import { useAppNav } from "../../shell/appNav";

// npm run release:preview starts the dev app with SETSU_DESIGNER=<version>: settings opens on the
// Messages tab with a note for that version. __designer("3.9.0") does the same from devtools
let requested: string | null = (typeof process !== "undefined" && process.env?.SETSU_DESIGNER) || null;

export function takeRequestedVersion(): string | null {
  const v = requested;
  requested = null;
  return v;
}

/** dev only, mounted in App */
export function DesignerGate() {
  const nav = useAppNav();
  useEffect(() => {
    if (requested) nav.openSettings("dev-messages");
    (window as unknown as Record<string, unknown>).__designer = (version?: string) => {
      if (version) requested = version;
      nav.openSettings("dev-messages");
      return "designer: Settings > Messages";
    };
  }, [nav]);
  return null;
}
