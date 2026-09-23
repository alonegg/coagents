#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findProjectBinding } from "./binding.js";
import { createConnectorServer } from "./server.js";

// stdout carries the MCP protocol; diagnostics go to stderr only.
const binding = findProjectBinding(process.cwd());
if (!binding.ok) {
  console.error(
    binding.reason === "not_found"
      ? "coagents: no .coagents/project.json found from the working directory"
      : `coagents: invalid ${binding.path}: ${binding.message}`,
  );
}

await createConnectorServer().connect(new StdioServerTransport());
