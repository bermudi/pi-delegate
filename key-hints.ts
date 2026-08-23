import * as piCodingAgent from "@earendil-works/pi-coding-agent";

type KeyText = (action: string) => string | undefined;

// Keep this lookup on the namespace object. A named ESM import makes the whole
// extension fail to load on older Pi hosts that do not export optional
// `keyText`, before the rendering fallback below can run.
const hostKeyText = (
  piCodingAgent as typeof piCodingAgent & { keyText?: KeyText }
).keyText;

/** Effective host keybinding for expanding tool output.
 *
 * Pi publishes `keyText`, which reads the live global keybinding manager and
 * therefore follows user remaps. Older/incompatible hosts omit the hint
 * rather than advertising a shortcut that may be wrong.
 */
export function toolExpandHint(
  verb = "expand",
  getKeyText: KeyText | undefined = hostKeyText,
): string {
  try {
    if (typeof getKeyText === "function") {
      const key = getKeyText("app.tools.expand");
      if (key) {
        const displayKey = key.replace(
          /(^|[+/])([a-z])/g,
          (_m, sep, char) => `${sep}${char.toUpperCase()}`,
        );
        return `${displayKey} ${verb}`;
      }
      return "";
    }
  } catch {
    // Rendering must remain available when an older host lacks keybindings.
  }
  return "";
}
