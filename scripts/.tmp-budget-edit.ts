// One-shot edit script for the tokenBudget removal (run with bun, then trash).
import { readFileSync, writeFileSync } from "node:fs";

let s = readFileSync("delegate.ts", "utf8");
const edit = (o, n) => {
  if (!s.includes(o)) throw new Error("NOT FOUND: " + JSON.stringify(o.slice(0, 70)));
  s = s.replaceAll(o, n);
};

// schema field
edit(
  `    tokenBudget: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Shared token ceiling for the whole batch: once settled tasks' recorded usage reaches it, tasks still queued settle 'budget-exhausted' instead of starting — running tasks always finish.",
      }),
    ),
`,
  "",
);

// flat-field allowlist
edit(`  "operationId",
  "tokenBudget",
`, `  "operationId",
`);

// string/fraction guards — the removal rejection replaces them
edit(
  `  if (typeof args.tokenBudget === "string") {
    throw new Error(
      "'tokenBudget' must be a positive integer, not a string.",
    );
  }
  // The TypeBox Integer schema silently floors a fractional value on
  // coercion — a corrupted ceiling must reject, not narrow (#47).
  if (
    typeof args.tokenBudget === "number" &&
    !Number.isInteger(args.tokenBudget)
  ) {
    throw new Error(
      \`'tokenBudget' must be a positive integer, not \${JSON.stringify(args.tokenBudget)}.\`,
    );
  }
`,
  "",
);

// manual line (dependsOn line above it survives)
edit(
  "- Batch `tokenBudget` stops starting queued tasks once settled usage reaches\n  the positive-integer ceiling; running tasks finish normally.\n",
  "",
);

// dispatch-options interface
edit(
  `    /** The shared batch token ceiling (SPEC v3 "Batch token budget"). */
    readonly tokenBudget?: number;
`,
  "",
);

// pipeline call
edit(
  `              brief: call.brief,
              tokenBudget: call.tokenBudget,
              syncRunId,`,
  `              brief: call.brief,
              syncRunId,`,
);

// coordinator options
edit(
  `          brief: options.brief,
          tokenBudget: options.tokenBudget,
        })`,
  `          brief: options.brief,
        })`,
);

// settlement hold condition
edit(
  `                        holdSettlement:
                          workspaceNeedsSettlementHold(tasks) ||
                          call.tokenBudget !== undefined,`,
  `                        holdSettlement: workspaceNeedsSettlementHold(tasks),`,
);

// ticket-creation header note
edit(
  `                      (call.tokenBudget !== undefined
                        ? \`\${budgetNote({ limit: call.tokenBudget, consumed: 0 })}\\n\`
                        : "") +
`,
  "",
);

// sync result text
edit(
  "formatDispatchResult(diagnostics, result.outcomes, tasks, outputBounds, call.brief, result.tokenBudget)",
  "formatDispatchResult(diagnostics, result.outcomes, tasks, outputBounds, call.brief)",
);

// sync result details
edit(
  `                // SPEC v3 "Batch token budget": the final account —
                // {limit, consumed, exhaustedAt} — when the call set one.
                ...(result.tokenBudget !== undefined
                  ? { tokenBudget: result.tokenBudget }
                  : {}),
`,
  "",
);

// ticket view details
edit(
  `              // SPEC v3 "Batch token budget": the settled batch's final
              // account rides the view (poll/wait), same as the sync result.
              ...(result.ticket?.tokenBudget !== undefined
                ? { tokenBudget: result.ticket.tokenBudget }
                : {}),
`,
  "",
);

writeFileSync("delegate.ts", s);
console.log("delegate stage ok");
