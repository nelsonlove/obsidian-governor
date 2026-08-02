// Shared McpServer stand-in for handler-level tests: records registerTool
// calls so tests can invoke handlers directly. (Not a *.test.mjs file — the
// test glob skips it.)
export function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, def, handler) {
      tools.set(name, { def, handler });
    },
  };
}
