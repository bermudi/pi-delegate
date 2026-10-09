// Convert addressing.test.ts tail vehicles to steer (#130 removed tail).
import { readFileSync, writeFileSync } from "node:fs";

let s = readFileSync("tests/contract/addressing.test.ts", "utf8");
const edit = (o, n) => {
  if (!s.includes(o)) throw new Error("NOT FOUND: " + JSON.stringify(o.slice(0, 70)));
  s = s.replaceAll(o, n);
};

// Test 2: ghost ticket / ghost task via steer receipts.
edit(
  `      const ghostTicket = await callDelegateTicket(session, {
        action: "tail",
        taskId: "t-00000000-0000-0000-0000-000000000000#holder",
      });
      expect(ghostTicket.isError).toBe(true);
      expect(ghostTicket.text).toContain("t-00000000-0000-0000-0000-000000000000");
      expect(ghostTicket.text).toContain(`"${ticket}"`);

      const ghostTask = await callDelegateTicket(session, {
        action: "tail",
        taskId: `${ticket}#ghost`,
      });
      expect(ghostTask.isError).toBe(true);
      expect(ghostTask.text).toContain(`"${ticket}#ghost"`);
      expect(ghostTask.text).toContain(`"${ticket}#holder"`);`,
  `      // #130: steer is the vehicle (tail was removed); an unknown ticket
      // or task lands in a not-applied receipt that names the known set.
      const ghostTicket = await callDelegateTicket(session, {
        action: "steer",
        taskId: "t-00000000-0000-0000-0000-000000000000#holder",
        message: "x",
      });
      expect(ghostTicket.text).toContain("t-00000000-0000-0000-0000-000000000000");

      const ghostTask = await callDelegateTicket(session, {
        action: "steer",
        taskId: `${ticket}#ghost`,
        message: "x",
      });
      expect(ghostTask.isError).toBe(false);
      expect(ghostTask.text).toContain("not-applied");
      expect(ghostTask.text).toContain(`"${ticket}#ghost"`);
      expect(ghostTask.text).toContain(`"${ticket}#holder"`);`,
);

// Test 3: disagreeing compound via steer.
edit(
  `      const conflict = await callDelegateTicket(session, {
        action: "tail",
        ticket,
        taskId: "t-other#holder",
      });`,
  `      const conflict = await callDelegateTicket(session, {
        action: "steer",
        ticket,
        taskId: "t-other#holder",
        message: "x",
      });`,
);

// Malformed loop via steer.
edit(
  `      for (const malformed of ["#holder", `${ticket}#`]) {
        const bad = await callDelegateTicket(session, {
          action: "tail",
          taskId: malformed,
        });`,
  `      for (const malformed of ["#holder", `${ticket}#`]) {
        const bad = await callDelegateTicket(session, {
          action: "steer",
          taskId: malformed,
          message: "x",
        });`,
);

// Test 4 body (already reworked for steer): no change needed.

writeFileSync("tests/contract/addressing.test.ts", s);
console.log("addressing converted");
