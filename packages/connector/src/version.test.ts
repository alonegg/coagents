import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CONNECTOR_VERSION } from "./server.js";

it("reports the published package version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(CONNECTOR_VERSION).toBe(pkg.version);
});
