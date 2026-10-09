// One-shot edit script: remove the tail action (+offset/waitMs) from the model surface.
import { readFileSync, writeFileSync } from "node:fs";

let s = readFileSync("src/tickets.ts", "utf8");
const edit = (o, n) => {
  if (!s.includes(o)) throw new Error("tickets NOT FOUND: " + JSON.stringify(o.slice(0, 80)));
  s = s.replaceAll(o, n);
};

// The tail method block: from its doc comment to the takePendingSteers doc.
const start = s.indexOf('   * delegate_ticket "tail" (issue #52)');
const end = s.indexOf('  /**\n   * Drain the parked steers');
if (start < 0 || end < 0 || end <= start) throw new Error("tail method bounds not found");
s = s.slice(0, start) + s.slice(end);

// RPC dispatch case
const caseStart = s.indexOf('    case "tail":');
if (caseStart < 0) throw new Error("tail case not found");
const caseEnd = s.indexOf("return {", caseStart);
// find the end of the case block: the next "\n    case " or the switch close
let next = s.indexOf("\n    case ", caseStart);
const switchEnd = s.indexOf("\n    }", caseStart);
if (next < 0 || (switchEnd >= 0 && switchEnd < next)) next = switchEnd;
s = s.slice(0, caseStart) + s.slice(next + 1);

writeFileSync("src/tickets.ts", s);

// delegate.ts: schema, TICKET_ACTIONS, manual, action description.
let d = readFileSync("delegate.ts", "utf8");
const dedit = (o, n) => {
  if (!d.includes(o)) throw new Error("delegate NOT FOUND: " + JSON.stringify(o.slice(0, 80)));
  d = d.replaceAll(o, n);
};

dedit(`const TICKET_ACTIONS = ["poll", "wait", "cancel", "answer", "steer", "interrupt", "tail"];`,
      `const TICKET_ACTIONS = ["poll", "wait", "cancel", "answer", "steer", "interrupt"];`);

dedit(`    action: stringEnum(["poll", "wait", "cancel", "answer", "steer", "interrupt", "tail"], {`,
      `    action: stringEnum(["poll", "wait", "cancel", "answer", "steer", "interrupt"], {`);

// offset + waitMs schema fields
const offsetField = d.indexOf("    offset: Type.Optional(");
const waitMsEnd = d.indexOf("}),\n  },\n  { additionalProperties: false },\n);\n\nconst sessionSchema");
if (offsetField < 0 || waitMsEnd < 0) throw new Error("offset/waitMs schema bounds not found");
d = d.slice(0, offsetField) + d.slice(waitMsEnd);

writeFileSync("delegate.ts", d);
console.log("tail surface edits ok");
