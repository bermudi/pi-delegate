// One-shot edit script: remove tail/offset/waitMs from delegate.ts.
import { readFileSync, writeFileSync } from "node:fs";

let d = readFileSync("delegate.ts", "utf8");
const edit = (o, n) => {
  if (!d.includes(o)) throw new Error("NOT FOUND: " + JSON.stringify(o.slice(0, 80)));
  d = d.replaceAll(o, n);
};

// schema: action enum + description tail sentence
edit(
  `    action: stringEnum(["poll", "wait", "cancel", "answer", "steer", "interrupt", "tail"], {`,
  `    action: stringEnum(["poll", "wait", "cancel", "answer", "steer", "interrupt"], {`,
);
edit(
  `unlike cancel's whole-ticket teardown. tail: read a task's clean assistant output incrementally — {text, nextOffset, done, taskState}; offset resumes the stream, waitMs bounds a park that resolves early on new output.",`,
  `unlike cancel's whole-ticket teardown.",`,
);

// schema: offset + waitMs fields
edit(
  `    offset: Type.Optional(
      Type.Number({
        description:
          "Only with action 'tail': char offset into the task's accumulated assistant output — pass back a prior nextOffset to continue the stream. Out-of-range values clamp.",
      }),
    ),
    waitMs: Type.Optional(
      Type.Number({
        description:
          "Only with action 'tail': bound the read — the call resolves early when new output lands or the task settles, and never later than this. Omitted or 0 is a pure snapshot.",
      }),
    ),
`,
  "",
);

// flat allowlist
edit(`  "steerId",
  "offset",
  "waitMs",
] as const;`, `  "steerId",
] as const;`);

// TICKET_ACTIONS
edit(
  `const TICKET_ACTIONS = ["poll", "wait", "cancel", "answer", "steer", "interrupt", "tail"];`,
  `const TICKET_ACTIONS = ["poll", "wait", "cancel", "answer", "steer", "interrupt"];`,
);

// action inference
edit(
  `        : isGiven(args.message) || isGiven(args.steerId)
          ? "steer"
          : typeof args.offset === "number" || typeof args.waitMs === "number"
            ? "tail"
            : Array.isArray(args.tickets) && args.tickets.length > 0
              ? "wait"
            : isGiven(args.taskId) ||`,
  `        : isGiven(args.message) || isGiven(args.steerId)
          ? "steer"
          : Array.isArray(args.tickets) && args.tickets.length > 0
            ? "wait"
            : isGiven(args.taskId) ||`,
);

// call-row rendering: tail block
edit(
  `  if (action === "tail") {
    if (typeof args.taskId === "string" && !isBlank(args.taskId)) {
      fields.push(\`taskId: \${JSON.stringify(args.taskId)}\`);
    }
    for (const key of ["offset", "waitMs"] as const) {
      if (typeof args[key] === "number") {
        fields.push(\`\${key}: \${JSON.stringify(args[key])}\`);
      }
    }
  }
`,
  "",
);

// dispatch-alias rejection list
edit(`    args.steerId !== undefined ||
    args.offset !== undefined ||
    args.waitMs !== undefined ||
    args.message !== undefined`, `    args.steerId !== undefined ||
    args.message !== undefined`);

// details wiring
edit(`              ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
              ...(result.tail !== undefined ? { tail: result.tail } : {}),`,
    `              ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),`);

// manual: tail section bullet(s)
const manualStart = d.indexOf("- `{ action: \"tail\", ticket, taskId?, offset?, waitMs? }`");
if (manualStart >= 0) {
  const manualEnd = d.indexOf("${HELP_TICKET_SHARED}", manualStart);
  if (manualEnd < 0) throw new Error("manual tail section end not found");
  d = d.slice(0, manualStart) + d.slice(manualEnd);
} else {
  throw new Error("manual tail bullet not found");
}

// manual intro actions list
edit(
  "poll, wait, cancel, answer, steer, interrupt, tail",
  "poll, wait, cancel, answer, steer, interrupt",
);

// ticket action description in schema also references tail defaults
edit(
  `"Only with actions 'answer', 'steer', 'interrupt', and 'tail': the task to target. With 'steer'/'interrupt' it defaults to the ticket's only still-running task; with 'tail' it also defaults to the ticket's only task. Accepts the canonical '<ticket>#<task>' address — the ticket field is then optional.",`,
  `"Only with actions 'answer', 'steer', and 'interrupt': the task to target. With 'steer'/'interrupt' it defaults to the ticket's only still-running task. Accepts the canonical '<ticket>#<task>' address — the ticket field is then optional.",`,
);

writeFileSync("delegate.ts", d);
console.log("delegate tail edits ok");
