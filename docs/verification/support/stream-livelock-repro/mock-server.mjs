// Layer-2 mock provider: real HTTP server speaking SSE, with scripted deaths.
// Usage: node mock-server.mjs <port> <scenario>
// Scenarios:
//   control         full clean stream
//   rst-mid-args    TCP reset mid tool-call arguments (socket.destroy)
//   fin-mid-args    clean FIN mid tool-call arguments (res.end, no [DONE])
//   blackhole       headers + partial args, then silence on an open socket

import http from "node:http";
import { sse, DONE, roleChunk, toolCallStartChunk, argsDeltaChunk, finishChunk, fragify, DELEGATE_ARGS } from "./sse.mjs";

const port = Number(process.argv[2] ?? 4711);
const scenario = process.argv[3] ?? "control";

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (chunk) => res.write(chunk);
  write(sse(roleChunk()));
  write(sse(toolCallStartChunk()));

  const frags = fragify(DELEGATE_ARGS);

  if (scenario === "control") {
    for (const frag of frags) write(sse(argsDeltaChunk(frag)));
    write(sse(finishChunk()));
    write(DONE);
    res.end();
  } else if (scenario === "rst-mid-args") {
    for (const frag of frags.slice(0, 4)) write(sse(argsDeltaChunk(frag)));
    res.flushHeaders?.();
    // destroy without end → RST to the client
    setTimeout(() => res.socket.destroy(), 30);
  } else if (scenario === "fin-mid-args") {
    for (const frag of frags.slice(0, 4)) write(sse(argsDeltaChunk(frag)));
    setTimeout(() => res.end(), 30);
  } else if (scenario === "blackhole") {
    for (const frag of frags.slice(0, 2)) write(sse(argsDeltaChunk(frag)));
    // open socket, silence forever (#8331 passive-hang family)
  } else if (scenario === "dup-args") {
    for (const frag of frags.slice(0, 4)) write(sse(argsDeltaChunk(frag)));
    // endless re-delivery of the same args fragment on a REAL socket:
    // provider-edge re-delivery / SDK resend class of failure
    const dupFrag = frags[4] ?? '{"x":';
    const iv = setInterval(() => write(sse(argsDeltaChunk(dupFrag))), 1);
    res.on("close", () => clearInterval(iv));
  } else {
    res.end(`unknown scenario ${scenario}`);
  }
});

server.listen(port, "127.0.0.1", () =>
  console.log(`[mock] ${scenario} on 127.0.0.1:${port}`),
);
