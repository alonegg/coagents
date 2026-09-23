import { describe, expect, it } from "vitest";
import { normalizeRemote } from "./handoffs.js";

describe("normalizeRemote", () => {
  it("treats ssh, https and credentialed forms of one repository as equal", () => {
    const forms = [
      "git@github.com:alonegg/coagents.git",
      "https://github.com/alonegg/coagents",
      "https://x-access-token:abc@github.com/alonegg/coagents.git",
      "ssh://git@GitHub.com/alonegg/coagents.git/",
      "https://github.com:443/alonegg/coagents.git",
    ];
    expect(new Set(forms.map(normalizeRemote))).toEqual(new Set(["github.com/alonegg/coagents"]));
    expect(normalizeRemote("git@github.com:alonegg/other.git")).toBe("github.com/alonegg/other");
  });
});
