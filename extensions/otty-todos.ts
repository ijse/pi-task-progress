// Project-local, session-scoped todo snapshots for Otty's terminal sidebar.
// This is intentionally separate from Otty's managed lifecycle extension.
import { createTodoPublisher } from "./otty-todos-core.mjs";

export default function (pi: any) {
  const publisher = createTodoPublisher();

  pi.on("tool_result", (event: unknown, ctx: unknown) => {
    publisher.handleToolResult(event, ctx);
  });
  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    publisher.publishCurrentState(ctx);
  });
  pi.on("session_tree", (_event: unknown, ctx: unknown) => {
    publisher.publishCurrentState(ctx);
  });
}
