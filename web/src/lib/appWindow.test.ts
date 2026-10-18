import { describe, expect, it } from "vitest";
import { isAppWindow, windowTitle } from "./appWindow";

describe("app window", () => {
  it("is detected from ?window=app", () => {
    expect(isAppWindow("?window=app")).toBe(true);
    expect(isAppWindow("?window=app&x=1")).toBe(true);
    expect(isAppWindow("")).toBe(false);
    expect(isAppWindow("?window=tab")).toBe(false);
  });

  it("titles the window by view and activity", () => {
    expect(windowTitle(false, false)).toBe("Luna");
    expect(windowTitle(true, false)).toBe("Luna · Control Center");
    expect(windowTitle(false, true)).toBe("● Luna");
  });
});
