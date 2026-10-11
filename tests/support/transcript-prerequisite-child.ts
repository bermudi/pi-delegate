import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "./pi-boundary.ts";

const agentDir = process.env.DELEGATE_AGENT_DIR;
if (!agentDir) throw new Error("Explicit scratch agent directory required");

const session = await openDelegateBoundary();
const model = await installSubagentModel(session);

let providerEntered!: () => void;
const entered = new Promise<void>((resolve) => {
  providerEntered = resolve;
});
model.respond([
  async () => {
    providerEntered();
    await new Promise<void>(() => {});
    return fauxAssistantMessage("OK");
  },
]);

const receipt = await callDelegate(session, {
  async: true,
  tasks: [{ prompt: "report" }],
});
if (receipt.isError) {
  throw new Error(`fixture dispatch rejected: ${receipt.text}`);
}
const ticket = ticketIdOf(receipt.text);
await entered;
process.stdout.write(
  JSON.stringify({ type: "ready", ticket, agentDir }) + "\n",
);
setInterval(() => {}, 60_000);
