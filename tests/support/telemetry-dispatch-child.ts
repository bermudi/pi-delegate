import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "./pi-boundary.ts";

const session = await openDelegateBoundary();
try {
  const subagents = await installSubagentModel(session);
  subagents.respond([fauxAssistantMessage("RACE-CHILD-OK")]);
  configureDelegate(session, { telemetry: { enabled: true } });
  const result = await callDelegate(session, {
    async: false,
    tasks: [{ prompt: "concurrent telemetry writer" }],
  });
  if (result.isError) {
    console.error(`delegate call failed: ${result.text}`);
    process.exitCode = 1;
  }
} finally {
  session.dispose();
}
