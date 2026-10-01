import { expect, test } from "bun:test";
import {
  callDelegate, delegateTool, installSubagentModel, openDelegateBoundary,
} from "../support/pi-boundary.ts";

// #118: user-approved removal supersedes SPEC-V2 task deadlines. Use the
// registered boundary so prepare/schema recovery cannot swallow this field.
for (const surface of ["compact", "full"] as const) {
  test(`${surface}: removed deadlineMs rejects by presence across recovery shapes before execution`, async () => {
    const session = await openDelegateBoundary({ surface });
    try {
      const model = await installSubagentModel(session);
      const schema = delegateTool(session).parameters as {
        properties: { tasks: { items: { properties: Record<string, unknown> } } };
      };
      expect(schema.properties.tasks.items.properties.deadlineMs).toBeUndefined();
      const manual = await callDelegate(session, {});
      expect(manual.text).not.toContain("deadlineMs");
      expect(delegateTool(session).description).not.toContain("deadlineMs");
      for (const deadlineMs of [100, 0, -1, null, "100", false]) {
        const task = { prompt: "must not run", deadlineMs };
        for (const input of [
          { tasks: [{ prompt: "sibling must not run" }, task] },
          { tasks: JSON.stringify([task]) },
          task,
          { tasks: [], ...task },
          { tasks: [{ prompt: "must not run" }], deadlineMs },
          { tasks: task },
        ]) {
          const rejected = await callDelegate(session, { async: false, ...input });
          expect(rejected.isError).toBe(true);
          expect(rejected.text).toMatch(/deadlineMs.*removed/i);
          expect(model.state.callCount).toBe(0);
        }
      }
    } finally {
      session.dispose();
    }
  });
}
