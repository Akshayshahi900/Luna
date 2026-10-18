// Copy text for the install steps. The clipboard is injectable for tests;
// older browsers without navigator.clipboard fall back to a hidden textarea.

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export async function copyText(text: string, clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard): Promise<boolean> {
  try {
    if (clipboard) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied: try the fallback */
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

/** Shell code without comment lines: what is worth pasting. */
export function commandsOnly(code: string): string {
  return code
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
}
