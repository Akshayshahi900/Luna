// Desktop-app behaviour for the window luna-web opens (src/luna/web/window.py):
// the page gets ?window=app, may play audio without a click, and should not
// act like a web page (no right-click menu, no stray text selection, no
// dragging the UI around).

/** True when this page is Luna's own app window. */
export function isAppWindow(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  return new URLSearchParams(search).get("window") === "app";
}

/** Window title for the current view. */
export function windowTitle(control: boolean, busy: boolean): string {
  return `${busy ? "● " : ""}Luna${control ? " · Control Center" : ""}`;
}

/** Elements where the normal browser behaviour (select, copy, context menu) stays. */
export const EDITABLE = "input, textarea, select, [contenteditable], .msg-body, .selectable, code, pre";

/** Make the page feel like an app; returns a function that undoes it. */
export function installAppBehaviour(doc: Document = document): () => void {
  doc.documentElement.classList.add("app-window");
  const onMenu = (e: MouseEvent) => {
    if (!(e.target as Element | null)?.closest?.(EDITABLE)) e.preventDefault();
  };
  const onDrag = (e: DragEvent) => {
    if (!(e.target as Element | null)?.closest?.(EDITABLE)) e.preventDefault();
  };
  doc.addEventListener("contextmenu", onMenu);
  doc.addEventListener("dragstart", onDrag);
  return () => {
    doc.documentElement.classList.remove("app-window");
    doc.removeEventListener("contextmenu", onMenu);
    doc.removeEventListener("dragstart", onDrag);
  };
}
