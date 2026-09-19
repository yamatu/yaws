// A minimal MCP server over stdio, used by server/test/mcp.test.mjs.
// Speaks newline-delimited JSON-RPC 2.0 and exposes one `echo` tool.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      });
    case "notifications/initialized":
      return;
    case "tools/list":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo the given text back.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
    case "tools/call":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` },
          ],
          isError: false,
        },
      });
    default:
      if (message.id !== undefined)
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "method not found" },
        });
  }
}
