import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { CONNECTOR_VERSION, createConnectorServer } from "./server.js";

it("identifies itself as coagents over MCP", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createConnectorServer().connect(serverSide);
  const client = new Client({ name: "test", version: CONNECTOR_VERSION });
  await client.connect(clientSide);
  expect(client.getServerVersion()).toMatchObject({ name: "coagents", version: CONNECTOR_VERSION });
  await client.close();
});
