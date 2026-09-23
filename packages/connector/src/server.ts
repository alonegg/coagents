import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const CONNECTOR_NAME = "coagents";
export const CONNECTOR_VERSION = "0.0.0";

// Tools are registered in M3; the shell exists so client configuration can be exercised early.
export function createConnectorServer(): McpServer {
  return new McpServer({ name: CONNECTOR_NAME, version: CONNECTOR_VERSION });
}
