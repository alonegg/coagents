import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createConnectorServer } from "./server.js";

it("identifies itself as coagents over MCP", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createConnectorServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0.1.0" });
  await client.connect(clientSide);
  expect(client.getServerVersion()).toMatchObject({ name: "coagents", version: "0.1.0" });
  await client.close();
});
