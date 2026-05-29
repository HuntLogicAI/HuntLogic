import { describe, it, expect } from "vitest";
import { chunkTelegramText } from "../telegram";

describe("chunkTelegramText", () => {
  it("returns a single chunk when under the limit", () => {
    const chunks = chunkTelegramText("short answer", 4096);
    expect(chunks).toEqual(["short answer"]);
  });

  it("splits long text into chunks that all respect the size limit", () => {
    const long = "word ".repeat(3000); // ~15,000 chars
    const chunks = chunkTelegramText(long, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
    }
    // No content lost (modulo whitespace trimming at break points).
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      long.replace(/\s+/g, " ").trim(),
    );
  });

  it("prefers to break on paragraph boundaries", () => {
    const para = "A".repeat(50);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkTelegramText(text, 60);
    // Each 50-char paragraph should land in its own chunk rather than being
    // split mid-paragraph.
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks).toContain(para);
  });

  it("hard-splits a single token longer than the limit", () => {
    const blob = "X".repeat(9000);
    const chunks = chunkTelegramText(blob, 4096);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("")).toBe(blob);
  });
});
