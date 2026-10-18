import { describe, expect, it } from "vitest";
import { cleanForSpeech, SentenceChunker } from "./speech";

describe("cleanForSpeech", () => {
  it("strips markdown so it reads naturally", () => {
    expect(cleanForSpeech("## Title\n- **bold** and `code` see [docs](http://x.y)")).toBe("Title bold and code see docs");
    expect(cleanForSpeech("Run:\n```py\nprint(1)\n```\nDone.")).toBe("Run: (code omitted) Done.");
    expect(cleanForSpeech("Go to https://example.com now")).toBe("Go to a link now");
  });
});

describe("SentenceChunker", () => {
  it("returns whole sentences as tokens stream in", () => {
    const c = new SentenceChunker();
    expect(c.push("Hello the")).toEqual([]);
    expect(c.push("re. How are")).toEqual(["Hello there."]);
    expect(c.push(" you? Fine")).toEqual(["How are you?"]);
    expect(c.pending).toBe(true);
    expect(c.flush()).toEqual(["Fine"]);
    expect(c.pending).toBe(false);
  });

  it("splits on blank lines and never inside code fences", () => {
    const c = new SentenceChunker();
    expect(c.push("A list\n\nItem")).toEqual(["A list"]);
    expect(c.push(" one. ```x = 1. y = 2.")).toEqual(["Item one."]);
    expect(c.push("``` After. ")).toEqual(["```x = 1. y = 2.``` After."]);
  });
});
