// @ts-nocheck

// extension.ts
import * as path8 from "node:path";
import { Type } from "@sinclair/typebox";
import { Text, Markdown } from "@mariozechner/pi-tui";
import {
  getMarkdownTheme
} from "@mariozechner/pi-coding-agent";

// constants.ts
var DEFAULT_TOOLS = ["read", "write", "edit", "bash"];
var READONLY_TOOLS = ["read", "grep", "find", "ls"];
var MAX_CONCURRENCY = 3;
var POOL_TTL_MS = 10 * 60 * 1e3;
var MAX_ASYNC_TICKETS = 5;
var ASYNC_TICKET_TTL_MS = 30 * 60 * 1e3;
var ASYNC_MAX_RUNTIME_MS = 30 * 60 * 1e3;
var VALID_THINKING = /* @__PURE__ */ new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

// tools.ts
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool
} from "@mariozechner/pi-coding-agent";
var TOOL_GROUPS = {
  "*": DEFAULT_TOOLS,
  ro: READONLY_TOOLS
};
var TOOL_FACTORIES = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool
};
function resolveToolGroups(tools) {
  const resolved = [];
  for (const t of tools) {
    const group = TOOL_GROUPS[t];
    if (group) resolved.push(...group);
    else resolved.push(t);
  }
  return [...new Set(resolved)];
}

// format.ts
import * as fs from "node:fs";
import * as path from "node:path";
var SPINNER = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
function spinnerFrame() {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length];
}
function getTermWidth() {
  return Math.max(40, Math.min(process.stdout.columns || 120, 200));
}
var _segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
var _wideCharRe = /[\u{1100}-\u{10FFFF}]/u;
var _combiningRe = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/u;
function charWidth(seg) {
  const cp = seg.codePointAt(0);
  if (cp < 32) return 0;
  if (cp === 127) return 0;
  if (cp >= 4352 && cp <= 4447) return 2;
  if (cp >= 11904 && cp <= 42191) return 2;
  if (cp >= 44032 && cp <= 55203) return 2;
  if (cp >= 63744 && cp <= 64255) return 2;
  if (cp >= 65040 && cp <= 65049) return 2;
  if (cp >= 65072 && cp <= 65135) return 2;
  if (cp >= 65280 && cp <= 65376) return 2;
  if (cp >= 65504 && cp <= 65510) return 2;
  if (cp >= 131072 && cp <= 262141) return 2;
  if (cp >= 126976 && cp <= 131069) return 2;
  if (cp >= 917504 && cp <= 917631) return 0;
  return 1;
}
function truncLine(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (!/\x1b\[[0-9;]*m/.test(text) && !_wideCharRe.test(text) && !_combiningRe.test(text)) {
    if (text.length <= maxWidth) return text;
    return text.slice(0, maxWidth - 1) + "\u2026";
  }
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  let totalVis = 0;
  for (const part of parts) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) continue;
    for (const segment of _segmenter.segment(part)) {
      totalVis += charWidth(segment.segment);
      if (totalVis > maxWidth) break;
    }
    if (totalVis > maxWidth) break;
  }
  if (totalVis <= maxWidth) return text;
  const target = maxWidth - 1;
  let result = "";
  let vis = 0;
  let activeStyles = [];
  for (const part of parts) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      result += part;
      if (part === "\x1B[0m" || part === "\x1B[m") activeStyles = [];
      else activeStyles.push(part);
      continue;
    }
    if (!_wideCharRe.test(part) && !_combiningRe.test(part) && vis + part.length <= target) {
      result += part;
      vis += part.length;
      continue;
    }
    for (const segment of _segmenter.segment(part)) {
      const seg = segment.segment;
      const w = charWidth(seg);
      if (vis + w > target) return result + activeStyles.join("") + "\u2026";
      result += seg;
      vis += w;
    }
  }
  return result;
}
function applyLineBudget(lines, expanded) {
  if (expanded) return [...lines];
  const rows = process.stdout.rows || 30;
  const budget = Math.max(10, Math.min(18, Math.floor(rows * 0.4)));
  if (lines.length <= budget) return [...lines];
  const hidden = lines.length - budget + 1;
  return [
    ...lines.slice(0, budget - 1),
    truncLine(`\u2026 ${hidden} lines hidden \xB7 Ctrl+O expands`, getTermWidth())
  ];
}
function shortenPath(p) {
  const home = process.env.HOME;
  if (!home || home === "/") return p;
  if (p === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (p.startsWith(prefix)) return "~" + path.sep + p.slice(prefix.length);
  return p;
}
function getActivityAge(lastActivityAt) {
  if (lastActivityAt === void 0) return "";
  const ago = Math.max(0, Date.now() - lastActivityAt);
  if (ago < 1e3) return "active now";
  if (ago < 6e4) return `active ${Math.floor(ago / 1e3)}s ago`;
  return `active ${Math.floor(ago / 6e4)}m ago`;
}
function fmtDuration(ms) {
  if (ms < 1e3) return `${ms}ms`;
  const s = ms / 1e3;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}m${secs}s`;
}
function fmtTokens(n) {
  return n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n / 1e3)}k`;
}
function trunc(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}
var tree = (i, n) => i === n - 1 ? "\u2514\u2500" : "\u251C\u2500";
var indent = (i, n) => i === n - 1 ? "   " : "\u2502  ";
function firstArg(args, primary, fallbacks = []) {
  for (const key of [primary, ...fallbacks]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val;
  }
  return void 0;
}
function formatToolCallShort(name, args) {
  if (!args || typeof args !== "object") return name;
  switch (name) {
    case "bash": {
      const cmd = firstArg(args, "command") ?? "...";
      const maxLen = 80;
      return `$ ${cmd.length > maxLen ? cmd.slice(0, maxLen) + "\u2026" : cmd}`;
    }
    case "read": {
      const p = shortenPath(firstArg(args, "path", ["file_path"]) ?? "...");
      const offset = typeof args.offset === "number" ? args.offset : void 0;
      const limit = typeof args.limit === "number" ? args.limit : void 0;
      let line = `read ${p}`;
      if (offset !== void 0 || limit !== void 0) {
        const start = offset ?? 1;
        const end = limit !== void 0 ? start + limit - 1 : "";
        line += `:${start}${end ? `-${end}` : ""}`;
      }
      return line;
    }
    case "write": {
      const p = shortenPath(firstArg(args, "path", ["file_path"]) ?? "...");
      const lines = String(args.content ?? "").split("\n").length;
      return `write ${p}${lines > 1 ? ` (${lines} lines)` : ""}`;
    }
    case "edit": {
      const p = shortenPath(firstArg(args, "path", ["file_path"]) ?? "...");
      return `edit ${p}`;
    }
    default: {
      for (const key of [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "task",
        "prompt"
      ]) {
        const val = args[key];
        if (typeof val === "string" && val.trim()) {
          const preview = val.length > 50 ? val.slice(0, 50) + "\u2026" : val;
          return `${name} ${preview}`;
        }
      }
      try {
        const preview = JSON.stringify(args).slice(0, 50);
        return `${name} ${preview}${preview.length >= 50 ? "\u2026" : ""}`;
      } catch {
        return name;
      }
    }
  }
}
function isResumableSessionFile(sessionFile) {
  if (!fs.existsSync(sessionFile)) return false;
  try {
    const content = fs.readFileSync(sessionFile, "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" || entry.type === "custom_message") {
          return true;
        }
      } catch {
      }
    }
  } catch {
  }
  return false;
}
function formatFailedTask(r) {
  const parts = [];
  const failParts = [r.error || "unknown error"];
  if (r.sessionFile) failParts.push(`session: ${shortenPath(r.sessionFile)}`);
  parts.push(`[FAILED: ${failParts.join(" \xB7 ")}]`);
  if (r.sessionFile && isResumableSessionFile(r.sessionFile)) {
    const safePath = JSON.stringify(r.sessionFile);
    parts.push(
      `\u2192 To retry: delegate({ tasks: [{ resumeFrom: ${safePath}, prompt: "continue" }] })`
    );
  } else if (r.sessionFile) {
    parts.push(`[no resumable session \u2014 re-dispatch as a fresh task]`);
  }
  return parts;
}

// pool.ts
var agentPool = /* @__PURE__ */ new Map();
var sessionLocks = /* @__PURE__ */ new Map();
async function withSessionLock(sessionId, fn) {
  const prev = sessionLocks.get(sessionId);
  let resolve5;
  const promise = new Promise((r) => {
    resolve5 = r;
  });
  sessionLocks.set(sessionId, promise);
  try {
    if (prev) await prev;
    return await fn();
  } finally {
    resolve5();
    if (sessionLocks.get(sessionId) === promise) {
      sessionLocks.delete(sessionId);
    }
  }
}
function closePooledAgent(sessionId) {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return false;
  try {
    void pooled.session.abort().catch(() => {
    });
  } catch {
  }
  agentPool.delete(sessionId);
  return true;
}
function sweepPool() {
  const now = Date.now();
  for (const [id, pooled] of agentPool) {
    if (sessionLocks.has(id)) continue;
    if (now - pooled.lastUsed > POOL_TTL_MS) {
      closePooledAgent(id);
    }
  }
}
function listPooledAgents() {
  sweepPool();
  const lines = [];
  if (agentPool.size === 0) return ["_(no active sessions)_"];
  for (const [id, pooled] of agentPool) {
    const idle = fmtDuration(Date.now() - pooled.lastUsed);
    const age = fmtDuration(Date.now() - pooled.createdAt);
    lines.push(
      `- **${id}** \xB7 ${pooled.promptCount} prompts \xB7 ${fmtTokens(pooled.totalTokens)} tokens \xB7 idle ${idle} \xB7 age ${age} \xB7 ${shortenPath(pooled.sessionFile)}`
    );
  }
  return lines;
}

// tickets.ts
import * as path2 from "node:path";
var ticketRegistry = /* @__PURE__ */ new Map();
function generateTicketId() {
  return Math.random().toString(36).slice(2, 10);
}
function sweepTickets() {
  const now = Date.now();
  for (const [id, ticket] of ticketRegistry) {
    if (ticket.status === "running" && now - ticket.created > ASYNC_MAX_RUNTIME_MS) {
      ticket.controller.abort();
      ticket.status = "failed";
      ticket.error = "Exceeded maximum runtime";
      ticket.completedAt = now;
    }
    if (ticket.status !== "running" && ticket.completedAt && now - ticket.completedAt > ASYNC_TICKET_TTL_MS) {
      ticketRegistry.delete(id);
    }
  }
}
function isSessionBusy(sessionId) {
  for (const ticket of ticketRegistry.values()) {
    if (ticket.status !== "running") continue;
    if (ticket.resolved.some((t) => t.sessionId === sessionId)) {
      return ticket.id;
    }
  }
  return null;
}
function formatCompletedTicket(ticket) {
  const parts = [];
  const succeeded = ticket.results.filter(
    (r) => r && !("error" in r && r.error)
  ).length;
  const elapsedTotal = ticket.completedAt ? ticket.completedAt - ticket.created : 0;
  parts.push(
    `${succeeded}/${ticket.results.length} tasks completed \xB7 ${fmtDuration(elapsedTotal)} wall time
`
  );
  for (let i = 0; i < ticket.results.length; i++) {
    const r = ticket.results[i];
    const t = ticket.resolved[i];
    if (!r) {
      parts.push(`=== ${t.agentName}: ${trunc(t.prompt || "", 80)} ===`);
      parts.push(`[PENDING \u2014 result not available]`);
      continue;
    }
    parts.push(`=== ${r.agent}: ${trunc(t.prompt || "", 80)} ===`);
    if (t.warnings?.length) {
      for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
    }
    if ("error" in r && r.error) {
      parts.push(...formatFailedTask(r));
    } else {
      const meta = [
        `OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`
      ];
      if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
      if (r.touchedFiles.length > 0) {
        const rel = r.touchedFiles.map((f) => path2.relative(t.cwd, f)).filter((f) => f && !f.startsWith(".."));
        if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
      }
      parts.push(`[${meta.join(" \xB7 ")}]

${r.output}`);
    }
  }
  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    details: {
      tasks: ticket.tasks,
      results: [...ticket.results].map(
        (r) => r ?? { error: "PENDING \u2014 result not available" }
      ),
      progress: [...ticket.progress],
      parentModel: ticket.parentModelId
    }
  };
}
function deliverTicketResults(pi, ticket) {
  if (!ticket.completedAt) return;
  const formatted = formatCompletedTicket(ticket);
  const text = formatted.content.filter(
    (c) => c.type === "text" && typeof c.text === "string"
  ).map((c) => c.text).join("\n");
  pi.sendMessage(
    {
      customType: "async_delegate_result",
      content: text,
      display: true,
      details: {
        ...formatted.details,
        ticketId: ticket.id,
        status: ticket.status
      }
    },
    {
      deliverAs: "steer",
      triggerTurn: true
    }
  );
}
function handlePoll(params, ctx) {
  sweepTickets();
  const parentModelId = ctx.model?.id;
  const ticketId = params.ticket;
  if (!ticketId) {
    const tickets = [...ticketRegistry.values()];
    if (!tickets.length) {
      return {
        content: [{ type: "text", text: "No async tickets." }],
        details: {
          tasks: [],
          results: [],
          progress: [],
          parentModel: parentModelId
        }
      };
    }
    const lines = tickets.map((t) => {
      const icon = t.status === "running" ? "\u23F3" : t.status === "done" ? "\u2713" : "\u2717";
      const done = t.progress.filter((p) => p.status === "done").length;
      const age = fmtDuration(Date.now() - t.created);
      return `${icon} ${t.id} \xB7 ${done}/${t.progress.length} tasks \xB7 ${t.status} \xB7 ${age}`;
    });
    return {
      content: [{ type: "text", text: `Async tickets:
${lines.join("\n")}` }],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId
      }
    };
  }
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [
        {
          type: "text",
          text: `Ticket '${ticketId}' not found. It may have expired or never existed.`
        }
      ],
      details: {
        tasks: [],
        results: [],
        progress: [],
        parentModel: parentModelId
      }
    };
  }
  if (ticket.status === "running") {
    const doneCount = ticket.progress.filter(
      (p) => p.status === "done" || p.status === "failed"
    ).length;
    const totalCount = ticket.progress.length;
    const lines = [];
    const completedResults = new Array(
      ticket.progress.length
    ).fill(void 0);
    for (let i = 0; i < ticket.progress.length; i++) {
      const p = ticket.progress[i];
      const r = ticket.results[i];
      if (p.status === "done" && r) {
        const meta = [
          fmtDuration(r.durationMs),
          `${fmtTokens(r.tokens)} tokens`
        ];
        if (r.touchedFiles.length > 0) {
          const t = ticket.resolved[i];
          const rel = r.touchedFiles.map((f) => path2.relative(t.cwd, f)).filter((f) => f && !f.startsWith(".."));
          if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
        }
        lines.push(`\u2713 ${r.agent} \xB7 ${meta.join(" \xB7 ")}`);
        if (r.output && r.output !== "(no output)") {
          lines.push(r.output);
        }
        completedResults[i] = r;
      } else if (p.status === "failed" && r) {
        lines.push(`\u2717 ${r.agent} \xB7 ${r.error ?? "unknown error"}`);
        if (r.sessionFile)
          lines.push(`  session: ${shortenPath(r.sessionFile)}`);
        if (r.output) lines.push(r.output);
        completedResults[i] = r;
      } else if (p.status === "running") {
        const activity = p.activities.findLast((a) => !a.result);
        const currentTool = activity ? ` \xB7 ${formatToolCallShort(activity.name, activity.args)}` : "";
        lines.push(
          `\u23F3 ${p.agent}${currentTool} \xB7 ${fmtDuration(Date.now() - ticket.created)}`
        );
      } else {
        lines.push(`\u25CB ${p.agent} \xB7 waiting\u2026`);
      }
    }
    const header = `Ticket ${ticket.id}: RUNNING \xB7 ${doneCount}/${totalCount} done (${fmtDuration(Date.now() - ticket.created)})`;
    const guidance = doneCount === totalCount ? "" : doneCount > 0 ? "Tasks are progressing. Do other work while remaining tasks finish \u2014 results will be delivered automatically when all complete." : "Tasks are still running. Do other work while you wait \u2014 polling again immediately will not speed them up. Results are delivered automatically when all tasks complete.";
    return {
      content: [
        {
          type: "text",
          text: `${header}
${lines.join("\n")}${guidance ? `

${guidance}` : ""}`
        }
      ],
      details: {
        tasks: ticket.tasks,
        results: completedResults.map(
          (r) => r ?? { error: "PENDING \u2014 result not available" }
        ),
        progress: [...ticket.progress],
        parentModel: ticket.parentModelId
      }
    };
  }
  return formatCompletedTicket(ticket);
}
function handleCancel(params) {
  sweepTickets();
  const ticketId = params.ticket;
  if (!ticketId) {
    return {
      content: [
        { type: "text", text: "action='cancel' requires a ticket ID." }
      ],
      details: { tasks: [], results: [], progress: [] }
    };
  }
  const ticket = ticketRegistry.get(ticketId);
  if (!ticket) {
    return {
      content: [{ type: "text", text: `Ticket '${ticketId}' not found.` }],
      details: { tasks: [], results: [], progress: [] }
    };
  }
  if (ticket.status !== "running") {
    return {
      content: [
        {
          type: "text",
          text: `Ticket '${ticketId}' is already ${ticket.status}.`
        }
      ],
      details: { tasks: [], results: [], progress: [] }
    };
  }
  ticket.controller.abort();
  ticket.status = "cancelled";
  ticket.completedAt = Date.now();
  return {
    content: [{ type: "text", text: `Ticket '${ticketId}' cancelled.` }],
    details: { tasks: [], results: [], progress: [] }
  };
}

// config.ts
import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path3 from "node:path";
var DELEGATE_CONFIG_DIR = path3.join(os.homedir(), ".pi", "agent");
var DELEGATE_CONFIG_PATH = path3.join(DELEGATE_CONFIG_DIR, "delegate.json");
var DEFAULT_DELEGATE_CONFIG = {
  agent: { default: null },
  concurrency: { default: MAX_CONCURRENCY },
  maxConcurrent: MAX_CONCURRENCY
};
var __delegateConfig = {
  ...DEFAULT_DELEGATE_CONFIG,
  agent: { ...DEFAULT_DELEGATE_CONFIG.agent },
  concurrency: { ...DEFAULT_DELEGATE_CONFIG.concurrency }
};
var sessionOverrides = { default: null };
function resetSessionOverrides() {
  sessionOverrides = { default: null };
}
function loadDelegateConfig() {
  try {
    const raw = fs2.readFileSync(DELEGATE_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return structuredClone(DEFAULT_DELEGATE_CONFIG);
    return {
      ...DEFAULT_DELEGATE_CONFIG,
      ...parsed,
      agent: { ...DEFAULT_DELEGATE_CONFIG.agent, ...parsed.agent ?? {} },
      concurrency: {
        ...DEFAULT_DELEGATE_CONFIG.concurrency,
        ...parsed.concurrency ?? {}
      }
    };
  } catch {
    return structuredClone(DEFAULT_DELEGATE_CONFIG);
  }
}
function saveDelegateConfigAtomic(config) {
  const tmpPath = DELEGATE_CONFIG_PATH + ".tmp";
  try {
    fs2.mkdirSync(DELEGATE_CONFIG_DIR, { recursive: true });
    fs2.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs2.renameSync(tmpPath, DELEGATE_CONFIG_PATH);
  } catch (err) {
    console.error(`[delegate] Failed to save config: ${err}`);
  }
}
function initDelegateConfig() {
  __delegateConfig = loadDelegateConfig();
}
initDelegateConfig();
function setModelOverride(type, value) {
  __delegateConfig.agent[type] = value;
  saveDelegateConfigAtomic(__delegateConfig);
}
function setDefaultModel(value) {
  __delegateConfig.agent.default = value;
  saveDelegateConfigAtomic(__delegateConfig);
}
function clearModelOverride(type) {
  delete __delegateConfig.agent[type];
  saveDelegateConfigAtomic(__delegateConfig);
}
function clearAllModelOverrides() {
  __delegateConfig.agent = { default: null };
  saveDelegateConfigAtomic(__delegateConfig);
}
function setConcurrencyDefault(n) {
  __delegateConfig.concurrency.default = Math.max(1, n);
  saveDelegateConfigAtomic(__delegateConfig);
}
function setConcurrencyProvider(key, n) {
  const current = __delegateConfig.concurrency.providers ?? {};
  __delegateConfig.concurrency.providers = {
    ...current,
    [key]: Math.max(1, n)
  };
  saveDelegateConfigAtomic(__delegateConfig);
}
function setConcurrencyModel(key, n) {
  const current = __delegateConfig.concurrency.models ?? {};
  __delegateConfig.concurrency.models = { ...current, [key]: Math.max(1, n) };
  saveDelegateConfigAtomic(__delegateConfig);
}
function removeConcurrencyProvider(key) {
  if (__delegateConfig.concurrency.providers) {
    delete __delegateConfig.concurrency.providers[key];
    saveDelegateConfigAtomic(__delegateConfig);
  }
}
function removeConcurrencyModel(key) {
  if (__delegateConfig.concurrency.models) {
    delete __delegateConfig.concurrency.models[key];
    saveDelegateConfigAtomic(__delegateConfig);
  }
}
function resetConcurrency() {
  __delegateConfig.concurrency = { ...DEFAULT_DELEGATE_CONFIG.concurrency };
  saveDelegateConfigAtomic(__delegateConfig);
}
function getConcurrencyLimit(modelKey) {
  const perModel = __delegateConfig.concurrency.models?.[modelKey];
  if (perModel != null) return perModel;
  const provider = modelKey.split("/")[0];
  const perProvider = __delegateConfig.concurrency.providers?.[provider];
  if (perProvider != null) return perProvider;
  return __delegateConfig.concurrency.default;
}
function getMaxAsyncTickets() {
  return __delegateConfig.maxAsyncTickets ?? MAX_ASYNC_TICKETS;
}
function getMaxConcurrent() {
  return __delegateConfig.maxConcurrent ?? MAX_CONCURRENCY;
}
function setMaxConcurrent(n) {
  __delegateConfig.maxConcurrent = Math.max(1, n);
  saveDelegateConfigAtomic(__delegateConfig);
}
function resolveModelSpec(options) {
  const {
    taskModel,
    agentType,
    frontmatterModel,
    config = __delegateConfig,
    overrides = sessionOverrides
  } = options;
  const candidates = [
    taskModel,
    overrides[agentType],
    overrides["default"],
    config.agent[agentType],
    config.agent["default"],
    frontmatterModel
  ];
  return candidates.find(
    (v) => typeof v === "string" && v.length > 0
  );
}

// agents.ts
import * as fs3 from "node:fs";
import * as os2 from "node:os";
import * as path4 from "node:path";
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: content.trim() };
  const data = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: m[2].trim() };
}
function findProjectRoot(cwd) {
  let dir = cwd;
  while (true) {
    if (fs3.existsSync(path4.join(dir, ".pi", "agents"))) return dir;
    const parent = path4.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function loadAgentFile(filePath) {
  let content;
  try {
    content = fs3.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content);
  if (!data.name || !data.description) return null;
  return {
    name: data.name,
    description: data.description,
    model: data.model,
    thinking: VALID_THINKING.has(data.thinking ?? "") ? data.thinking : "off",
    tools: data.tools ? resolveToolGroups(
      data.tools.split(",").map((s) => s.trim()).filter(Boolean)
    ) : [],
    // named agents must declare tools; empty triggers a resolution error
    systemPrompt: body
  };
}
function discoverAgents(cwd) {
  const dirs = [];
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot)
    dirs.push({
      dir: path4.join(projectRoot, ".pi", "agents"),
      scope: "project"
    });
  dirs.push({
    dir: path4.join(os2.homedir(), ".pi", "agent", "agents"),
    scope: "global"
  });
  dirs.push({ dir: path4.join(os2.homedir(), ".agents"), scope: "global" });
  const agents = /* @__PURE__ */ new Map();
  for (const { dir, scope } of dirs) {
    let entries;
    try {
      entries = fs3.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name.endsWith(".md") || e.name.endsWith(".chain.md")) continue;
      const cfg = loadAgentFile(path4.join(dir, e.name));
      if (cfg && !agents.has(cfg.name)) {
        cfg.scope = scope;
        agents.set(cfg.name, cfg);
      }
    }
  }
  return agents;
}
function loadSkill(name, cwd) {
  const candidates = [
    // Project (standard → pi-specific)
    path4.join(cwd, ".agents", "skills", name, "SKILL.md"),
    path4.join(cwd, ".pi", "skills", name, "SKILL.md"),
    // User (standard → pi-specific)
    path4.join(os2.homedir(), ".agents", "skills", name, "SKILL.md"),
    path4.join(os2.homedir(), ".pi", "agent", "skills", name, "SKILL.md")
  ];
  for (const p of candidates) {
    try {
      return fs3.readFileSync(p, "utf-8");
    } catch {
    }
  }
  return null;
}
function loadAgentsMdFiles(cwd) {
  const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const seen = /* @__PURE__ */ new Set();
  const files = [];
  const tryLoad = (dir, priority) => {
    for (const name of candidates) {
      const fp = path4.join(dir, name);
      if (seen.has(fp)) return;
      seen.add(fp);
      try {
        const content = fs3.readFileSync(fp, "utf-8").trim();
        if (content) {
          files.push({ priority, content });
          return;
        }
      } catch {
      }
    }
  };
  const agentDir = path4.join(os2.homedir(), ".pi", "agent");
  tryLoad(agentDir, 0);
  const ancestorDirs = [];
  let current = path4.resolve(cwd);
  const root = path4.resolve("/");
  while (true) {
    ancestorDirs.unshift(current);
    if (current === root) break;
    const parent = path4.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (let i = 0; i < ancestorDirs.length; i++) {
    if (ancestorDirs[i] === root) continue;
    tryLoad(ancestorDirs[i], i + 1);
  }
  return files.sort((a, b) => a.priority - b.priority).map((f) => f.content);
}
var DEFAULT_SUBAGENT_SYSTEM_PROMPT = "You are a helpful coding assistant.";
function firstNonBlank(...values) {
  return values.find(
    (v) => typeof v === "string" && v.trim().length > 0
  );
}
function buildSubagentSystemPrompt(options) {
  if (options.pooledSystemPrompt?.trim()) return options.pooledSystemPrompt;
  const base = firstNonBlank(
    options.taskSystemPrompt,
    options.agentSystemPrompt,
    options.parentSystemPrompt
  ) ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT;
  return base;
}

// parent-context.ts
import {
  buildSessionContext
} from "@mariozechner/pi-coding-agent";
function buildParentTranscript(entries, leafId) {
  try {
    const ctx = buildSessionContext(entries, leafId);
    const lines = [];
    for (const msg of ctx.messages) {
      if (msg.role === "user") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**User:** ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const text = extractTextContent(msg.content);
        if (text) lines.push(`**Assistant:** ${text.trim()}`);
      }
    }
    return lines.join("\n\n") || null;
  } catch {
    return null;
  }
}
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(
    (b) => b.type === "text" && typeof b.text === "string"
  ).map((b) => b.text).join("");
}

// model.ts
function resolveModel(spec, registry, parentModel) {
  if (!spec) return parentModel;
  const idx = spec.indexOf("/");
  if (idx === -1) {
    const match = registry.getAvailable().find((m) => m.id === spec);
    return match ?? void 0;
  }
  return registry.find(spec.slice(0, idx), spec.slice(idx + 1)) ?? void 0;
}
function findAvailableAlternative(model, registry) {
  if (!model) return void 0;
  if (registry.hasConfiguredAuth(model)) return model;
  return registry.getAvailable().find((m) => m.id === model.id && m.provider !== model.provider);
}

// settings.ts
import * as fs4 from "node:fs";
import * as os3 from "node:os";
import * as path5 from "node:path";
function readDelegateSettingsFile(filePath) {
  try {
    const raw = fs4.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function getDelegateSettings(filePath) {
  const settings = readDelegateSettingsFile(filePath);
  if (!settings?.delegate || typeof settings.delegate !== "object" || Array.isArray(settings.delegate))
    return null;
  return settings.delegate;
}
var delegateSettingsCache = /* @__PURE__ */ new Map();
function loadDelegateSettings(cwd) {
  const key = path5.resolve(cwd);
  const cached = delegateSettingsCache.get(key);
  if (cached !== void 0) return cached;
  const userPath = path5.join(os3.homedir(), ".pi", "agent", "settings.json");
  let projectPath = null;
  let dir = key;
  const root = path5.resolve("/");
  while (true) {
    if (fs4.existsSync(path5.join(dir, ".pi"))) {
      projectPath = path5.join(dir, ".pi", "settings.json");
      break;
    }
    if (dir === root) break;
    const parent = path5.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const user = getDelegateSettings(userPath);
  const project = projectPath ? getDelegateSettings(projectPath) : null;
  if (!user && !project) {
    delegateSettingsCache.set(key, null);
    return null;
  }
  const result = {
    agentOverrides: {
      ...user?.agentOverrides ?? {},
      ...project?.agentOverrides ?? {}
    }
  };
  delegateSettingsCache.set(key, result);
  return result;
}

// concurrency.ts
async function mapConcurrent(items, concurrency, fn, signal) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
function getModelKey(model) {
  return model ? `${model.provider}/${model.id}` : "_no_model";
}
async function mapConcurrentByModel(items, getModelKey2, getConcurrency, fn, signal, maxTotal) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  const groups = /* @__PURE__ */ new Map();
  for (let i = 0; i < items.length; i++) {
    const key = getModelKey2(items[i], i);
    let group = groups.get(key);
    if (!group) {
      group = { indices: [], limit: getConcurrency(key) };
      groups.set(key, group);
    }
    group.indices.push(i);
  }
  let totalRunning = 0;
  const totalWaiters = [];
  const acquireTotal = async () => {
    if (!maxTotal || totalRunning < maxTotal) {
      totalRunning++;
      return;
    }
    await new Promise((r) => totalWaiters.push(r));
  };
  const releaseTotal = () => {
    totalRunning--;
    if (totalWaiters.length > 0) {
      totalRunning++;
      totalWaiters.shift()();
    }
  };
  await Promise.all(
    [...groups.entries()].map(([, group]) => {
      const groupItems = group.indices.map((i) => items[i]);
      return mapConcurrent(
        groupItems,
        group.limit,
        async (_item, localIdx) => {
          await acquireTotal();
          try {
            const globalIdx = group.indices[localIdx];
            results[globalIdx] = await fn(_item, globalIdx);
            return results[globalIdx];
          } finally {
            releaseTotal();
          }
        },
        signal
      );
    })
  );
  return results;
}

// lifecycle.ts
import * as fs6 from "node:fs";
import {
  createAgentSession,
  SessionManager as SessionManager2
} from "@mariozechner/pi-coding-agent";

// sessions.ts
import * as fs5 from "node:fs";
import { SessionManager } from "@mariozechner/pi-coding-agent";
function setParentSession(sm, parentPath) {
  const inner = sm;
  const header = inner.fileEntries[0];
  if (header && header.type === "session") {
    header.parentSession = parentPath;
    const file = inner.getSessionFile?.();
    if (file && fs5.existsSync(file)) {
      try {
        inner._rewriteFile?.();
      } catch {
      }
    }
  }
}
function createSubagentSessionManager(parentSessionManager, cwd) {
  const parentFile = parentSessionManager?.getSessionFile?.();
  const sm = SessionManager.create(cwd);
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) return void 0;
  if (parentFile) {
    setParentSession(sm, parentFile);
  }
  return { manager: sm, file: sessionFile };
}
function persistSessionHeader(sm) {
  const inner = sm;
  const file = inner.getSessionFile?.();
  if (!file) return false;
  if (fs5.existsSync(file)) return true;
  try {
    inner._rewriteFile?.();
  } catch {
  }
  return fs5.existsSync(file);
}

// file-tracking.ts
import { execFile } from "node:child_process";
import * as path6 from "node:path";
async function getGitChangedFiles(cwd) {
  try {
    const result = await new Promise((resolve5, reject) => {
      execFile(
        "git",
        ["status", "--porcelain", "--untracked-files=all"],
        { cwd, timeout: 5e3 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve5(stdout);
        }
      );
    });
    const files = /* @__PURE__ */ new Set();
    for (const line of result.split("\n")) {
      if (line.length < 4) continue;
      const rawPath = line.slice(3).trim();
      if (!rawPath) continue;
      const targetPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      if (targetPath)
        files.add(path6.resolve(cwd, targetPath.replace(/^"|"$/g, "")));
    }
    return files;
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function extractTouchedFromActivities(activities, cwd) {
  const files = /* @__PURE__ */ new Set();
  for (const a of activities) {
    if (a.name !== "edit" && a.name !== "write") continue;
    const raw = a.args?.path ?? a.args?.file_path ?? a.args?.filePath;
    if (typeof raw !== "string" || !raw) continue;
    files.add(path6.resolve(cwd, raw));
  }
  return [...files];
}

// utils.ts
import * as os4 from "node:os";
import * as path7 from "node:path";
function resolveCwd(cwd) {
  const expanded = cwd.startsWith("~") ? path7.join(os4.homedir(), cwd.slice(1)) : cwd;
  return path7.resolve(expanded);
}
function extractTextFromPartialResult(partialResult) {
  if (!partialResult || typeof partialResult !== "object" || !("content" in partialResult))
    return void 0;
  const content = partialResult.content;
  if (!Array.isArray(content)) return void 0;
  const text = content.filter(
    (c) => c && typeof c === "object" && "type" in c && c.type === "text"
  ).map((c) => c.text).filter((t) => typeof t === "string").join("\n");
  return text || void 0;
}
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
function resolveCarriageReturn(text) {
  return text.split("\n").map((line) => {
    const parts = line.split("\r");
    return parts[parts.length - 1] ?? "";
  }).join("\n");
}
function extractOutput(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}
function extractUsage(messages) {
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    const u = msg.usage;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.total += u.total ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
}

// runner.ts
async function runAgentSession(session, prompt, config, signal, onProgress, gitBaseline, start) {
  const startTime = start || Date.now();
  let toolUses = 0;
  let lastActivityAt;
  const activities = [];
  const pendingById = /* @__PURE__ */ new Map();
  const usageBeforeTotal = extractUsage(session.messages).total;
  const fireProgress = () => {
    if (!onProgress) return;
    const usage = extractUsage(session.messages);
    const delta = Math.max(0, usage.total - usageBeforeTotal);
    onProgress({
      tokens: delta,
      toolUses,
      durationMs: Date.now() - startTime,
      lastActivityAt,
      activities: [...activities]
    });
  };
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start": {
        const now = Date.now();
        lastActivityAt = now;
        const activity = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          startTime: now
        };
        pendingById.set(event.toolCallId, activity);
        activities.push(activity);
        fireProgress();
        break;
      }
      case "tool_execution_update": {
        lastActivityAt = Date.now();
        const activity = pendingById.get(event.toolCallId);
        if (activity) {
          const text = extractTextFromPartialResult(event.partialResult);
          if (text !== void 0) activity.liveOutput = text;
          fireProgress();
        }
        break;
      }
      case "tool_execution_end": {
        const now = Date.now();
        lastActivityAt = now;
        const activity = pendingById.get(event.toolCallId);
        if (activity) {
          activity.result = {
            content: event.result?.content ?? [],
            isError: event.isError
          };
          activity.endTime = now;
          pendingById.delete(event.toolCallId);
        }
        toolUses++;
        fireProgress();
        break;
      }
      case "message_end": {
        lastActivityAt = Date.now();
        fireProgress();
        break;
      }
      default:
        break;
    }
  });
  let abortHandler;
  if (signal) {
    abortHandler = () => {
      void session.abort().catch(() => {
      });
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  if (signal?.aborted) {
    abortHandler?.();
    return {
      output: "",
      error: "Aborted",
      durationMs: Date.now() - startTime,
      tokens: 0,
      touchedFiles: []
    };
  }
  try {
    const messagesBefore = session.messages.length;
    await session.prompt(prompt);
    const messages = session.messages;
    const state = session.state;
    const errorMessage = state.errorMessage;
    const output = extractOutput(messages.slice(messagesBefore));
    const usageAfterTotal = extractUsage(messages).total;
    const tokensThisCall = Math.max(0, usageAfterTotal - usageBeforeTotal);
    const fromActivities = extractTouchedFromActivities(activities, config.cwd);
    const gitAfter = await getGitChangedFiles(config.cwd);
    const fromGit = [...gitAfter].filter((f) => !gitBaseline.has(f));
    const touchedFiles = [.../* @__PURE__ */ new Set([...fromActivities, ...fromGit])];
    return {
      output: output || "(no output)",
      error: errorMessage,
      durationMs: Date.now() - startTime,
      tokens: tokensThisCall,
      touchedFiles
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: "",
      error: msg,
      durationMs: Date.now() - startTime,
      tokens: 0,
      touchedFiles: []
    };
  } finally {
    if (signal && abortHandler)
      signal.removeEventListener("abort", abortHandler);
    unsubscribe();
  }
}

// host.ts
import {
  AuthStorage,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir
} from "@mariozechner/pi-coding-agent";
var hostDepsCache = /* @__PURE__ */ new Map();
var hostDepsInflight = /* @__PURE__ */ new Map();
var testRetryBaseMs;
async function getHostDeps(options) {
  const key = `${options.cwd}\0${options.systemPrompt ?? ""}`;
  const cached = hostDepsCache.get(key);
  if (cached) return cached;
  const inflight = hostDepsInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    const agentDir = options.agentDir ?? getAgentDir();
    const authStorage = AuthStorage.create();
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    if (testRetryBaseMs !== void 0) {
      installFastRetry(settingsManager, testRetryBaseMs);
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      // Subagents are headless workers — they must not load the parent's
      // interactive extensions. This also neutralizes the shared-runtime
      // cross-wiring risk (see module doc): with no extensions, no handlers
      // bind to the mutated runtime methods, so the cached loader is safe to
      // share across live sessions.
      noExtensions: true,
      // When a named agent supplies a custom prompt, it becomes the loader's
      // customPrompt — overriding the default system prompt AgentSession would
      // otherwise build. `systemPrompt` (the source) wins over file discovery.
      ...options.systemPrompt !== void 0 ? { systemPrompt: options.systemPrompt } : {}
    });
    await resourceLoader.reload();
    const deps = { authStorage, settingsManager, resourceLoader };
    hostDepsCache.set(key, deps);
    return deps;
  })();
  hostDepsInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    hostDepsInflight.delete(key);
  }
}
function installFastRetry(sm, baseDelayMs) {
  sm.getRetrySettings = (() => ({
    enabled: true,
    maxRetries: 3,
    baseDelayMs
  }));
}

// lifecycle.ts
function failTask(task, error, sessionFile) {
  return {
    agent: task.agentName,
    output: "",
    error,
    durationMs: 0,
    tokens: 0,
    sessionFile,
    touchedFiles: []
  };
}
function completeSessionAction(task, output, elapsedMs) {
  return {
    agent: task.agentName,
    output,
    durationMs: elapsedMs ?? 0,
    tokens: 0,
    sessionFile: void 0,
    touchedFiles: []
  };
}
function updateProgressFromRun(p, u) {
  p.tokens = u.tokens;
  p.toolUses = u.toolUses;
  p.durationMs = u.durationMs;
  p.lastActivityAt = u.lastActivityAt;
  p.activities = u.activities;
}
function updateProgressFromResult(p, r) {
  p.status = r.error ? "failed" : "done";
  p.durationMs = r.durationMs;
  p.tokens = r.tokens;
  p.error = r.error;
}
function finishTask(env, p, r) {
  updateProgressFromResult(p, r);
  env.onStatusChange?.();
  return r;
}
async function buildDelegateSession(env, task, sessionManager) {
  const hostDeps = await getHostDeps({
    cwd: task.cwd,
    systemPrompt: task.systemPrompt
  });
  const { session } = await createAgentSession({
    cwd: task.cwd,
    model: task.model,
    thinkingLevel: task.thinking,
    tools: task.tools,
    sessionManager,
    // Reuse the extension's shared registry (parent's) for consistent auth/model resolution.
    modelRegistry: env.modelRegistry,
    // Shared, read-only heavy deps (resourceLoader.reload() runs once per cwd, cached).
    authStorage: hostDeps.authStorage,
    settingsManager: hostDeps.settingsManager,
    resourceLoader: hostDeps.resourceLoader
  });
  return session;
}
async function acquireAgentSession(env, task, p) {
  let sessionManager;
  let sessionFile;
  let isPoolHit = false;
  let shouldPoolAfter = false;
  if (task.sessionId) {
    const pooled = agentPool.get(task.sessionId);
    if (pooled) {
      const frozen = pooled.config;
      const mismatches = [];
      if (frozen.cwd !== task.cwd)
        mismatches.push(`cwd: '${frozen.cwd}' vs '${task.cwd}'`);
      if (frozen.thinking !== task.thinking)
        mismatches.push(`thinking: '${frozen.thinking}' vs '${task.thinking}'`);
      const frozenToolSet = [...frozen.tools].sort().join(",");
      const newToolSet = [...task.tools].sort().join(",");
      if (frozenToolSet !== newToolSet)
        mismatches.push(`tools: [${frozenToolSet}] vs [${newToolSet}]`);
      if (mismatches.length) {
        return {
          error: failTask(
            task,
            `Session '${task.sessionId}' config mismatch. Close and recreate: ${mismatches.join("; ")}`
          )
        };
      }
      pooled.lastUsed = Date.now();
      p.model = frozen.model.id;
      return {
        session: pooled.session,
        sessionManager: pooled.sessionManager,
        sessionFile: pooled.sessionFile,
        isPoolHit: true,
        shouldPoolAfter: false,
        syncInserted: false
      };
    }
  }
  if (task.resumeFrom) {
    if (task.sessionId && agentPool.has(task.sessionId)) {
      return {
        error: failTask(
          task,
          `resumeFrom conflicts with active sessionId '${task.sessionId}'. The pooled session has its own accumulated context. Close the session first if you want to resume from a different point.`
        )
      };
    }
    const resolvedPath = resolveCwd(task.resumeFrom);
    if (!fs6.existsSync(resolvedPath)) {
      return {
        error: failTask(
          task,
          `resumeFrom: file not found: ${resolvedPath}`,
          resolvedPath
        )
      };
    }
    let resumed;
    try {
      resumed = SessionManager2.open(resolvedPath);
    } catch {
      return {
        error: failTask(
          task,
          `resumeFrom: corrupt session: ${resolvedPath}`,
          resolvedPath
        )
      };
    }
    if (!resumed.buildSessionContext().messages.length) {
      return {
        error: failTask(
          task,
          `resumeFrom: empty session: ${resolvedPath}`,
          resolvedPath
        )
      };
    }
    const parentFile = env.parentSessionManager?.getSessionFile?.();
    if (parentFile) setParentSession(resumed, parentFile);
    const session2 = await buildDelegateSession(env, task, resumed);
    return {
      session: session2,
      sessionManager: resumed,
      sessionFile: resolvedPath,
      isPoolHit: false,
      // A resumed session under a sessionId becomes poolable after success.
      shouldPoolAfter: Boolean(task.sessionId),
      syncInserted: false
    };
  }
  const fresh = createSubagentSessionManager(
    env.parentSessionManager,
    task.cwd
  );
  if (!fresh) {
    return { error: failTask(task, "Internal: could not create session file") };
  }
  sessionManager = fresh.manager;
  sessionFile = fresh.file;
  const session = await buildDelegateSession(env, task, sessionManager);
  return {
    session,
    sessionManager,
    sessionFile,
    isPoolHit: false,
    shouldPoolAfter: Boolean(task.sessionId),
    syncInserted: false
  };
}
function commitPoolInsert(sessionId, task, acquired, result) {
  if (!acquired.sessionManager || !acquired.sessionFile) return;
  agentPool.set(sessionId, {
    session: acquired.session,
    sessionManager: acquired.sessionManager,
    sessionFile: acquired.sessionFile,
    config: {
      systemPrompt: task.systemPrompt,
      model: task.model,
      thinking: task.thinking,
      tools: task.tools,
      cwd: task.cwd
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    totalTokens: result.tokens,
    promptCount: 1
  });
}
function commitPoolStats(sessionId, result) {
  const pooled = agentPool.get(sessionId);
  if (!pooled) return;
  pooled.lastUsed = Date.now();
  pooled.totalTokens += result.tokens;
  pooled.promptCount++;
}
function resolveResumableSessionFile(sessionFile, sessionManager, error) {
  if (!sessionFile) return void 0;
  if (error && sessionManager) persistSessionHeader(sessionManager);
  return fs6.existsSync(sessionFile) ? sessionFile : void 0;
}
async function runResolvedTask(env, task, p, taskIndex) {
  if (task.sessionId) {
    return withSessionLock(
      task.sessionId,
      () => runResolvedTaskUnlocked(env, task, p, taskIndex)
    );
  }
  return runResolvedTaskUnlocked(env, task, p, taskIndex);
}
async function runResolvedTaskUnlocked(env, task, p, taskIndex) {
  try {
    if (env.signal?.aborted) {
      return finishTask(env, p, failTask(task, "Aborted"));
    }
    if (task.sessionId) {
      const busyTicketId = isSessionBusy(task.sessionId);
      if (busyTicketId && busyTicketId !== env.ticketId) {
        const msg = `Session '${task.sessionId}' is already in use by ticket ${busyTicketId}. Each session can only handle one task at a time.`;
        return finishTask(env, p, failTask(task, msg));
      }
    }
    p.status = "running";
    p.model = task.model?.id;
    if (task.action === "close") {
      if (!task.sessionId) {
        return finishTask(
          env,
          p,
          failTask(task, "action='close' requires sessionId.")
        );
      }
      const closed = closePooledAgent(task.sessionId);
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          closed ? `Session '${task.sessionId}' closed.` : `Session '${task.sessionId}' not found.`,
          Date.now() - env.delegateStartedAt
        )
      );
    }
    if (task.action === "list") {
      return finishTask(
        env,
        p,
        completeSessionAction(
          task,
          `Active sessions:
${listPooledAgents().join("\n")}`,
          Date.now() - env.delegateStartedAt
        )
      );
    }
    const acquired = await acquireAgentSession(env, task, p);
    if ("error" in acquired) {
      return finishTask(env, p, acquired.error);
    }
    if (env.signal?.aborted) {
      return finishTask(env, p, failTask(task, "Aborted"));
    }
    const doRun = async () => {
      try {
        const gitBaseline = await getGitChangedFiles(task.cwd);
        const r = await runAgentSession(
          acquired.session,
          task.prompt,
          { cwd: task.cwd },
          env.signal,
          (u) => env.onProgress(p, u),
          gitBaseline,
          Date.now()
        );
        if (task.sessionId && !r.error) {
          if (acquired.shouldPoolAfter) {
            commitPoolInsert(task.sessionId, task, acquired, r);
          } else {
            commitPoolStats(task.sessionId, r);
          }
        }
        return {
          agent: task.agentName,
          output: r.output,
          error: r.error,
          durationMs: r.durationMs,
          tokens: r.tokens,
          sessionFile: resolveResumableSessionFile(
            acquired.sessionFile,
            acquired.sessionManager,
            r.error
          ),
          touchedFiles: r.touchedFiles
        };
      } catch (err) {
        throw err;
      }
    };
    const result = await doRun();
    return finishTask(env, p, result);
  } catch (err) {
    return finishTask(
      env,
      p,
      failTask(task, err instanceof Error ? err.message : String(err))
    );
  }
}

// extension.ts
var delegateParameters = Type.Object({
  action: Type.Optional(
    Type.String({
      enum: ["poll", "cancel"]
    })
  ),
  async: Type.Optional(Type.Boolean()),
  ticket: Type.Optional(Type.String()),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        prompt: Type.Optional(Type.String()),
        agent: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        // ── Undocumented overrides — accepted but not advertised in schema.
        // Discovered via empty-tasks help text.
        systemPrompt: Type.Optional(Type.String()),
        context: Type.Optional(
          Type.String({ enum: ["fresh", "with-parent-transcript"] })
        ),
        model: Type.Optional(Type.String()),
        tools: Type.Optional(Type.Array(Type.String())),
        thinking: Type.Optional(
          Type.String({
            enum: [...VALID_THINKING]
          })
        ),
        sessionId: Type.Optional(Type.String()),
        action: Type.Optional(
          Type.String({
            enum: ["prompt", "close", "list", "poll", "cancel"]
          })
        ),
        resumeFrom: Type.Optional(Type.String())
      }),
      {
        minItems: 0
      }
    )
  )
});
function getSubagentManualMarkdown(agents) {
  const entries = [...agents];
  const agentList = entries.length ? entries.map(([n, a]) => {
    const model = a.model ? ` (model: ${a.model})` : "";
    const thinking = a.thinking !== "off" ? ` [thinking: ${a.thinking}]` : "";
    const tools = a.tools.length !== DEFAULT_TOOLS.length || a.tools.some((t, i) => t !== DEFAULT_TOOLS[i]) ? ` tools: ${a.tools.join(", ")}` : "";
    const scope = a.scope === "project" ? " [project]" : a.scope === "global" ? " [global]" : "";
    return `- **${n}**${model}${thinking}${tools}${scope}: ${a.description}`;
  }).join("\n") : "_(none defined)_";
  return [
    "# Delegate Tool Manual",
    "",
    "Delegate subagents to execute tasks in parallel. Each subagent gets an independent context, system prompt, model, tools, and thinking level.",
    "",
    "## Available Agents",
    "",
    agentList,
    "",
    "Agents live in `.pi/agents/*.md` (project-local) and `~/.pi/agent/agents/` (global). Each agent file is Markdown with YAML-ish frontmatter:",
    "",
    "```markdown",
    "---",
    "name: my-agent",
    "description: What it does",
    "model: anthropic/claude-haiku-4-5  # optional",
    "thinking: low                     # off/minimal/low/medium/high/xhigh",
    "tools: *                          # * = full agent. ro = read-only. Named agents must declare.",
    "---",
    "You are a helpful agent...",
    "```",
    "",
    "## Task Fields",
    "",
    "- `prompt` \u2014 The task for this subagent. Optional when `resumeFrom` is set (defaults to a continuation prompt).",
    "- `agent` \u2014 Named agent from the list above. Inline fields override agent defaults.",
    "- `systemPrompt` \u2014 System prompt. Falls back to agent definition, then parent session system prompt.",
    "- `model` \u2014 e.g. `anthropic/claude-sonnet-4`. Falls back to agent default, then parent model.",
    "- `tools` \u2014 Tool names or shorthands (`*` = full: read,write,edit,bash; `ro` = read-only: read,grep,find,ls). Inline tasks default to `*`; named agents must declare.",
    "- `thinking` \u2014 off, minimal, low, medium, high, xhigh. Default: agent setting or 'off'.",
    "- `cwd` \u2014 Working directory for the subagent (settings, AGENTS.md resolution). Default: parent session cwd. Named-agent discovery is always parent-session-scoped regardless of per-task cwd.",
    "- `context` \u2014 'fresh' (default) or 'with-parent-transcript' to inject the full parent conversation into the subagent's prompt (token-expensive \u2014 use deliberately).",
    "- `sessionId` \u2014 Name for a persistent subagent. First use creates it, subsequent calls reuse the same agent (multi-turn).",
    "- `action` \u2014 Per-task action: 'prompt' (default), 'close' to tear down a pooled session, 'list' to show active sessions.",
    "- top-level `action` \u2014 Async ticket action: 'poll' or 'cancel'. Does not require `tasks`.",
    "",
    "## Session Reuse",
    "",
    "When `sessionId` is set, the subagent is kept alive in a pool for the duration of the pi session.",
    "Subsequent calls with the same `sessionId` continue the conversation \u2014 the agent remembers prior context.",
    "",
    "```json",
    "// First call \u2014 creates and runs",
    '{ "prompt": "Investigate the auth module", "agent": "scout", "sessionId": "auth-research" }',
    "",
    "// Second call \u2014 continues the same agent",
    '{ "prompt": "Now check the tests for that module", "sessionId": "auth-research" }',
    "",
    "// Clean up when done",
    '{ "prompt": "", "sessionId": "auth-research", "action": "close" }',
    "```",
    "",
    `Pooled agents are automatically closed after ${POOL_TTL_MS / 6e4} minutes of inactivity.`,
    "",
    "## Resuming Previous Sessions",
    "",
    "Use `resumeFrom` to continue a failed or interrupted subagent from where it left off.",
    "Pass the absolute path to the session `.jsonl` file (shown in delegate output).",
    "The agent gets the full conversation history and the new `prompt` continues naturally.",
    "",
    "```json",
    "// Resume a failed browser test \u2014 agent remembers everything it already did",
    '{ "prompt": "Continue testing \u2014 the server is already running on :3000",',
    '  "resumeFrom": "/home/user/.pi/agent/sessions/project/2026-01-01T12-00-00Z_abc123.jsonl" }',
    "```",
    "",
    "Combine with `sessionId` to resume AND pool the agent for further multi-turn use:",
    "",
    "```json",
    '{ "prompt": "Continue the investigation",',
    '  "resumeFrom": "/path/to/session.jsonl",',
    '  "sessionId": "my-resumed-agent" }',
    "```",
    "",
    "## Async Mode",
    "",
    "Set `async: true` on the top-level call to fire tasks in the background:",
    "",
    "```json",
    'delegate({ async: true, tasks: [{ agent: "scout", prompt: "Investigate auth" }] })',
    "```",
    "\u2192 Returns ticket ID immediately. Parent keeps working.",
    "",
    '- `delegate({ action: "poll" })` \u2014 list all tickets',
    '- `delegate({ action: "poll", ticket: "abc123" })` \u2014 check one ticket',
    '- `delegate({ action: "cancel", ticket: "abc123" })` \u2014 abort a running ticket',
    "",
    `Max ${getMaxAsyncTickets()} concurrent async tickets. Results are delivered automatically when all tasks finish. Poll for progress while running, but avoid polling in a tight loop \u2014 do other work while waiting.`,
    "",
    "## Gotchas",
    "",
    '- `*` means the full agent (read, write, edit, bash), not "every tool." The grep/find/ls trio exists only for `ro` (read-only) agents where bash is unavailable \u2014 bash already subsumes them.',
    "- Named agent profiles must declare a `tools:` field; inline tasks default to `*`.",
    "- Subagents inherit all skills discovered in their `cwd` (via AgentSession's resource loader). Per-task skill filtering is not supported \u2014 curate the cwd's skill set instead.",
    `- Sync \`delegate\` runs at most ${getMaxConcurrent()} tasks at once (the rest queue, not fail). Use \`async: true\` to move work to the background.`,
    "- `with-parent-transcript` injects your entire conversation. A 50k-token session means the subagent starts 50k tokens deep.",
    "",
    "## Config",
    "",
    "Tunables live in `~/.pi/agent/delegate.json`: `maxConcurrent` (sync ceiling), `maxAsyncTickets` (background ticket cap), per-model/per-provider concurrency limits, and global model overrides."
  ].join("\n");
}
function delegateExtension(pi) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to Subagents",
    description: "Run the delegate tool with an empty task array for help text and a list of configured subagents.",
    parameters: delegateParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const parentModelId = ctx.model?.id;
      const tasks = params.tasks ?? [];
      if (params.action === "poll" || tasks.some((t) => t.action === "poll")) {
        return handlePoll(params, ctx);
      }
      if (params.action === "cancel" || tasks.some((t) => t.action === "cancel")) {
        return handleCancel(params);
      }
      const agents = discoverAgents(ctx.cwd);
      if (!tasks.length) {
        return {
          content: [{ type: "text", text: getSubagentManualMarkdown(agents) }],
          details: {
            tasks: [],
            results: [],
            progress: [],
            parentModel: parentModelId
          }
        };
      }
      const sessionIds = tasks.map((t) => t.sessionId).filter(Boolean);
      const duplicateSessions = sessionIds.filter(
        (id, i) => sessionIds.indexOf(id) !== i
      );
      if (duplicateSessions.length) {
        return {
          content: [
            {
              type: "text",
              text: `Duplicate sessionId(s) across tasks: ${[...new Set(duplicateSessions)].join(", ")}. Each session can only handle one task at a time.`
            }
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId
          }
        };
      }
      const busyConflicts = [];
      for (const sid of sessionIds) {
        const owner = isSessionBusy(sid);
        if (owner) busyConflicts.push(`${sid} (ticket ${owner})`);
      }
      if (busyConflicts.length) {
        return {
          content: [
            {
              type: "text",
              text: `Session(s) already in use: ${busyConflicts.join(", ")}. Each session can only handle one task at a time.`
            }
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId
          }
        };
      }
      const unknown = [];
      for (const t of tasks) {
        if (t.agent && !agents.has(t.agent)) unknown.push(t.agent);
      }
      if (unknown.length) {
        const names = [...agents.keys()];
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${names.join(", ") || "(none)"}. Call delegate with an empty tasks array for help.`
            }
          ],
          details: {
            tasks,
            results: [],
            progress: [],
            parentModel: parentModelId
          }
        };
      }
      let parentTranscript = null;
      const needsParentContext = tasks.some(
        (t) => t.context === "with-parent-transcript"
      );
      if (needsParentContext) {
        if (!ctx.sessionManager) {
          throw new Error(
            "context: 'with-parent-transcript' requires a persisted parent session."
          );
        }
        parentTranscript = buildParentTranscript(
          ctx.sessionManager.getEntries(),
          ctx.sessionManager.getLeafId()
        );
      }
      const getParentSystemPrompt = ctx.getSystemPrompt;
      const parentSystemPrompt = typeof getParentSystemPrompt === "function" ? getParentSystemPrompt.call(ctx) : void 0;
      const resolved = tasks.map((t, i) => {
        const agent = t.agent ? agents.get(t.agent) : void 0;
        const cwd = resolveCwd(t.cwd ?? ctx.cwd);
        const settings = loadDelegateSettings(cwd);
        const agentOverride = t.agent && settings?.agentOverrides?.[t.agent] ? settings.agentOverrides[t.agent] : void 0;
        const pooledConfig = t.sessionId ? agentPool.get(t.sessionId)?.config : void 0;
        if (t.action !== "close" && t.action !== "list" && !t.resumeFrom && !t.prompt?.trim()) {
          throw new Error(
            `Task ${i}: prompt is required unless action is 'close'/'list' or resumeFrom is set.`
          );
        }
        const systemPrompt = buildSubagentSystemPrompt({
          taskSystemPrompt: t.systemPrompt,
          agentSystemPrompt: agent?.systemPrompt,
          parentSystemPrompt,
          pooledSystemPrompt: pooledConfig?.systemPrompt
        });
        let prompt = t.prompt || (t.resumeFrom ? "Continue from where you left off. Pick up the task and keep going." : t.prompt);
        const parentCtx = t.context === "with-parent-transcript" && parentTranscript ? parentTranscript : null;
        if (parentCtx) {
          prompt = [
            "<parent-session>",
            "The following is the conversation from the parent session.",
            "Read this for context, then execute the task below.",
            "Do not continue the parent conversation or respond to prior messages.",
            "",
            parentCtx,
            "</parent-session>",
            "",
            "## Task",
            prompt
          ].join("\n");
        }
        let model;
        let tools = [];
        let thinking = "off";
        const warnings = [];
        if (t.action !== "close" && t.action !== "list") {
          if (t.sessionId && agentPool.has(t.sessionId)) {
            model = agentPool.get(t.sessionId).config.model;
          } else {
            const agentType = t.agent ?? "inline";
            const modelSpec = resolveModelSpec({
              taskModel: t.model ?? agentOverride?.model,
              agentType,
              frontmatterModel: agent?.model
            });
            const resolvedModel = modelSpec ? resolveModel(modelSpec, ctx.modelRegistry, ctx.model) : void 0;
            const explicitRequest = t.model ?? agentOverride?.model;
            if (explicitRequest && !resolvedModel) {
              throw new Error(
                `Task ${i}: requested model '${explicitRequest}' is not available. Check provider config or remove the model field to use the parent model.`
              );
            }
            model = resolvedModel ?? findAvailableAlternative(ctx.model, ctx.modelRegistry) ?? ctx.model;
          }
          if (!model) {
            throw new Error(
              `Task ${i}: no model available \u2014 parent session has no model set.`
            );
          }
          const isPoolHit = t.sessionId ? agentPool.has(t.sessionId) : false;
          tools = resolveToolGroups(
            t.tools ?? agentOverride?.tools ?? agent?.tools ?? (isPoolHit ? pooledConfig?.tools : void 0) ?? DEFAULT_TOOLS
          );
          const unknownTools = tools.filter(
            (name) => !(name in TOOL_FACTORIES)
          );
          if (unknownTools.length) {
            warnings.push(
              `Unknown tool(s) ignored: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`
            );
          }
          if (agent && agent.tools.length === 0 && !t.tools && !agentOverride?.tools) {
            throw new Error(
              `Task ${i}: agent "${t.agent}" has no \`tools:\` field. Declare one, e.g. \`tools: *\` (full) or \`tools: ro\` (read-only).`
            );
          }
          const thinkingRaw = t.thinking ?? agentOverride?.thinking ?? agent?.thinking ?? (isPoolHit ? pooledConfig?.thinking : void 0) ?? "off";
          thinking = VALID_THINKING.has(thinkingRaw) ? thinkingRaw : "off";
        }
        return {
          ...t,
          cwd,
          systemPrompt,
          model,
          tools,
          thinking,
          prompt,
          agentName: agent?.name ?? "inline",
          warnings
        };
      });
      const startedAt = Date.now();
      const progress = resolved.map((t, i) => ({
        index: i,
        agent: t.agentName,
        task: trunc(t.prompt || t.action || "", 50),
        status: "pending",
        durationMs: 0,
        tokens: 0,
        toolUses: 0,
        activities: [],
        model: t.model?.id
      }));
      const fire = () => onUpdate?.({
        content: [
          {
            type: "text",
            text: `Running ${resolved.length} subagent${resolved.length > 1 ? "s" : ""}\u2026`
          }
        ],
        details: {
          tasks,
          results: [],
          progress: [...progress],
          parentModel: parentModelId
        }
      });
      fire();
      if (params.async) {
        sweepTickets();
        const runningCount = [...ticketRegistry.values()].filter(
          (t) => t.status === "running"
        ).length;
        if (runningCount >= getMaxAsyncTickets()) {
          return {
            content: [
              {
                type: "text",
                text: `Too many async tickets running (${runningCount}/${getMaxAsyncTickets()}). Poll existing tickets or cancel one first.`
              }
            ],
            details: {
              tasks,
              results: [],
              progress: [],
              parentModel: parentModelId
            }
          };
        }
        const ticketId = generateTicketId();
        const controller = new AbortController();
        const ticket = {
          id: ticketId,
          created: Date.now(),
          tasks,
          resolved,
          status: "running",
          results: new Array(resolved.length),
          progress: [...progress],
          controller,
          parentModelId
        };
        ticketRegistry.set(ticketId, ticket);
        const ticketSignal = controller.signal;
        const modelRegistry = ctx.modelRegistry;
        const asyncEnv = {
          signal: ticketSignal,
          modelRegistry,
          parentSessionManager: ctx.sessionManager,
          ticketId,
          delegateStartedAt: ticket.created,
          onProgress: (p, u) => {
            updateProgressFromRun(p, u);
          }
        };
        mapConcurrentByModel(
          resolved,
          (t) => getModelKey(t.model),
          getConcurrencyLimit,
          async (t, i) => {
            const result = await runResolvedTask(
              asyncEnv,
              t,
              ticket.progress[i],
              i
            );
            ticket.results[i] = result;
            return result;
          },
          ticketSignal,
          getMaxConcurrent()
        ).then(() => {
          const anyFailed = ticket.results.some(
            (r) => r && "error" in r && r.error
          );
          const allSettled = ticket.progress.every(
            (p) => p.status === "done" || p.status === "failed"
          );
          if (ticket.status === "running") {
            if (allSettled && anyFailed) ticket.status = "failed";
            else if (allSettled) ticket.status = "done";
            else ticket.status = "done";
            ticket.completedAt = Date.now();
          }
          deliverTicketResults(pi, ticket);
        }).catch((err) => {
          ticket.status = "failed";
          ticket.error = err instanceof Error ? err.message : String(err);
          ticket.completedAt = Date.now();
          deliverTicketResults(pi, ticket);
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Async ticket: ${ticketId}`,
                `${resolved.length} task(s) dispatched \xB7 ${runningCount + 1}/${getMaxAsyncTickets()} async slots in use`,
                "",
                "Completed task results are available via poll. Final results delivered automatically when all tasks complete.",
                `Check progress: delegate({ action: "poll", ticket: "${ticketId}" }) \u2014 avoid polling in a tight loop`,
                `Cancel if needed: delegate({ action: "cancel", ticket: "${ticketId}" })`
              ].join("\n")
            }
          ],
          details: {
            tasks,
            results: [],
            progress: [...progress],
            parentModel: parentModelId,
            ticketId
          }
        };
      }
      sweepPool();
      const syncEnv = {
        signal,
        modelRegistry: ctx.modelRegistry,
        parentSessionManager: ctx.sessionManager,
        ticketId: void 0,
        delegateStartedAt: startedAt,
        onProgress: (p, u) => {
          updateProgressFromRun(p, u);
          fire();
        },
        onStatusChange: () => fire()
      };
      const results = await mapConcurrentByModel(
        resolved,
        (t) => getModelKey(t.model),
        getConcurrencyLimit,
        async (t, i) => runResolvedTask(syncEnv, t, progress[i], i),
        signal,
        getMaxConcurrent()
      );
      const finalResults = results;
      const elapsedTotal = Date.now() - startedAt;
      const parts = [];
      const succeeded = finalResults.filter((r) => !r.error).length;
      parts.push(
        `${succeeded}/${finalResults.length} tasks completed successfully \xB7 ${fmtDuration(elapsedTotal)} wall time
`
      );
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i];
        const t = resolved[i];
        parts.push(
          `=== ${r.agent}: ${trunc(t.prompt || t.action || "", 80)} ===`
        );
        if (t.warnings?.length) {
          for (const w of t.warnings) parts.push(`[WARNING: ${w}]`);
        }
        if (r.error) {
          parts.push(...formatFailedTask(r));
        } else {
          const meta = [
            `OK | ${fmtDuration(r.durationMs)} | ${fmtTokens(r.tokens)} tokens`
          ];
          if (r.sessionFile) meta.push(shortenPath(r.sessionFile));
          if (r.touchedFiles.length > 0) {
            const rel = r.touchedFiles.map((f) => path8.relative(t.cwd, f)).filter((f) => f && !f.startsWith(".."));
            if (rel.length) meta.push(`touched: ${rel.join(", ")}`);
          }
          parts.push(`[${meta.join(" \xB7 ")}]

${r.output}`);
        }
      }
      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: {
          tasks,
          results: finalResults,
          progress,
          parentModel: parentModelId
        }
      };
    },
    renderCall(args, theme, ctx) {
      const state = ctx.state;
      const tasks = args.tasks ?? [];
      const text = ctx.lastComponent ?? new Text("", 0, 0);
      if (!tasks.length) {
        text.setText(theme.fg("toolTitle", theme.bold("delegate")));
        return text;
      }
      if (ctx.executionStarted && ctx.isPartial) {
        if (state.startedAt === void 0) state.startedAt = Date.now();
        const elapsed = fmtDuration(Date.now() - state.startedAt);
        text.setText(
          theme.fg(
            "toolTitle",
            theme.bold(
              `${spinnerFrame()} delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""} \xB7 ${elapsed}`
            )
          )
        );
        return text;
      }
      text.setText(
        theme.fg(
          "toolTitle",
          theme.bold(
            `delegate ${tasks.length} task${tasks.length > 1 ? "s" : ""}`
          )
        )
      );
      return text;
    },
    renderResult(result, options, theme, ctx) {
      const state = ctx.state;
      const tickMs = 80;
      if (options.isPartial && !state.interval)
        state.interval = setInterval(() => ctx.invalidate(), tickMs);
      if (!options.isPartial && state.interval) {
        clearInterval(state.interval);
        state.interval = void 0;
      }
      const text = ctx.lastComponent ?? new Text("", 0, 0);
      const details = result.details;
      if (!details?.progress?.length) {
        const content = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
        text.setText(content ? `
${content}` : "");
        return text;
      }
      const { progress, results: taskResults } = details;
      const total = progress.length;
      const w = getTermWidth() - 4;
      const lines = [""];
      const statJoin = (parts) => parts.length ? theme.fg("muted", ` \xB7 ${parts.join(" \xB7 ")}`) : "";
      const modelLabel = (p) => p.model ? ` ${theme.fg("accent", p.model)}` : "";
      const compactActivity = (p) => {
        const current = p.activities.findLast((a) => !a.result);
        if (current) {
          const call = formatToolCallShort(current.name, current.args);
          const toolAge = fmtDuration(Date.now() - current.startTime);
          return `${call} | ${toolAge}`;
        }
        if (p.activities.length > 0) {
          const last = p.activities[p.activities.length - 1];
          const call = formatToolCallShort(last.name, last.args);
          return `${call} \u2713`;
        }
        return "thinking\u2026";
      };
      if (options.isPartial) {
        const done = progress.filter(
          (p) => p.status === "done" || p.status === "failed"
        ).length;
        const running = progress.filter((p) => p.status === "running").length;
        const elapsed = state.startedAt ? ` \xB7 ${fmtDuration(Date.now() - state.startedAt)}` : "";
        const headerParts = [];
        if (running > 0) headerParts.push(`${running} running`);
        headerParts.push(`${done}/${total} done`);
        lines.push(
          theme.fg("muted", `${headerParts.join(" \xB7 ")}${elapsed}`),
          ""
        );
        for (let i = 0; i < total; i++) {
          const p = progress[i];
          const ind = indent(i, total);
          const runParts = [];
          if (p.toolUses > 0)
            runParts.push(`${p.toolUses} tool${p.toolUses > 1 ? "s" : ""}`);
          if (p.tokens > 0) runParts.push(`${fmtTokens(p.tokens)} tokens`);
          switch (p.status) {
            case "done":
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("success", "\u2713")} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
                  w
                )
              );
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(
                    activity.name,
                    activity.args
                  );
                  const icon = activity.result?.isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `\u2192 ${call}`)} ${icon}`,
                      w
                    )
                  );
                }
              }
              break;
            case "failed":
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("error", "\u2717")} ${theme.bold(p.agent)}${modelLabel(p)}${p.error ? theme.fg("error", ` ${p.error}`) : ""}`,
                  w
                )
              );
              if (options.expanded) {
                for (const activity of p.activities.slice(-3)) {
                  const call = formatToolCallShort(
                    activity.name,
                    activity.args
                  );
                  const icon = activity.result?.isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `\u2192 ${call}`)} ${icon}`,
                      w
                    )
                  );
                }
              }
              break;
            case "running":
              {
                const activityAge = getActivityAge(p.lastActivityAt);
                const ageTag = activityAge ? ` \xB7 ${activityAge}` : "";
                const glyph = theme.fg("warning", spinnerFrame());
                lines.push(
                  truncLine(
                    `${tree(i, total)} ${glyph} ${theme.bold(p.agent)}${modelLabel(p)}${statJoin(runParts)}${theme.fg("muted", ageTag)}`,
                    w
                  )
                );
                if (options.expanded) {
                  if (p.activities.length > 0) {
                    for (const activity of p.activities.slice(-5)) {
                      const call = formatToolCallShort(
                        activity.name,
                        activity.args
                      );
                      if (!activity.result) {
                        const elapsed2 = ` | ${fmtDuration(Date.now() - activity.startTime)}`;
                        lines.push(
                          truncLine(
                            `${ind}${theme.fg("warning", `> ${call}${elapsed2}`)}`,
                            w
                          )
                        );
                        if (activity.liveOutput) {
                          const clean = stripAnsi(
                            resolveCarriageReturn(activity.liveOutput)
                          );
                          const preview = clean.split("\n").filter((l) => l.trim()).slice(-3);
                          for (const outLine of preview) {
                            lines.push(
                              truncLine(
                                `${ind}  ${theme.fg("toolOutput", outLine)}`,
                                w
                              )
                            );
                          }
                        }
                      } else {
                        const icon = activity.result.isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
                        lines.push(
                          truncLine(
                            `${ind}${theme.fg("muted", `\u2192 ${call}`)} ${icon}`,
                            w
                          )
                        );
                      }
                    }
                  } else {
                    lines.push(
                      truncLine(`${ind}${theme.fg("muted", "  thinking\u2026")}`, w)
                    );
                  }
                } else {
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("muted", `\u23BF  ${compactActivity(p)}`)}`,
                      w
                    )
                  );
                  lines.push(
                    truncLine(
                      `${ind}${theme.fg("accent", "Press Ctrl+O for live detail")}`,
                      w
                    )
                  );
                }
              }
              break;
            default:
              lines.push(
                truncLine(
                  `${tree(i, total)} ${theme.fg("muted", "\u25CB")} ${theme.bold(p.agent)}${modelLabel(p)} ${theme.fg("muted", "waiting\u2026")}`,
                  w
                )
              );
          }
        }
        const budgeted = applyLineBudget(
          lines.filter(Boolean),
          options.expanded ?? false
        );
        lines.length = 0;
        lines.push(...budgeted);
      } else {
        const succeeded = progress.filter((p) => p.status === "done").length;
        const totalTokens = progress.reduce((sum, p) => sum + p.tokens, 0);
        const elapsed = state.startedAt ? fmtDuration(Date.now() - state.startedAt) : fmtDuration(progress.reduce((sum, p) => sum + p.durationMs, 0));
        lines.push(
          theme.fg(
            "muted",
            `${succeeded}/${total} completed \xB7 ${elapsed} wall \xB7 ${fmtTokens(totalTokens)} tokens`
          ),
          ""
        );
        for (let i = 0; i < total; i++) {
          const p = progress[i];
          const r = taskResults[i];
          const ind = indent(i, total);
          const icon = p.status === "done" ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
          const taskPreview = theme.fg("muted", trunc(p.task, w - 30));
          lines.push(
            truncLine(
              `${tree(i, total)} ${icon} ${theme.bold(p.agent)}${modelLabel(p)} ${taskPreview}${statJoin([fmtDuration(p.durationMs), `${fmtTokens(p.tokens)} tokens`])}`,
              w
            )
          );
          if (p.activities.length > 0 && options.expanded) {
            const names = p.activities.map((a) => a.name).filter((n, i2, arr) => arr.indexOf(n) === i2);
            const nameList = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
            const okCount = p.activities.filter(
              (a) => a.result && !a.result.isError
            ).length;
            const errCount = p.activities.filter(
              (a) => a.result?.isError
            ).length;
            const statusParts = [];
            if (okCount > 0) statusParts.push(`${okCount} \u2713`);
            if (errCount > 0) statusParts.push(`${errCount} \u2717`);
            const status = statusParts.length ? ` \xB7 ${statusParts.join(", ")}` : "";
            lines.push(
              truncLine(
                `${ind}${theme.fg("muted", `${p.activities.length} tool${p.activities.length > 1 ? "s" : ""}: ${nameList}${status}`)}`,
                w
              )
            );
          }
          if (r && "error" in r && r.error) {
            lines.push(truncLine(`${ind}${theme.fg("error", r.error)}`, w));
          }
          if (r && "output" in r && r.output?.trim() && r.output !== "(no output)" && options.expanded) {
            const cacheKey = `md_${i}_${options.expanded ? "exp" : "col"}_${w - ind.length}`;
            let mdLines = state[cacheKey];
            if (!mdLines || state[`${cacheKey}_src`] !== r.output) {
              const md = new Markdown(
                r.output.trim(),
                0,
                0,
                getMarkdownTheme()
              );
              mdLines = md.render(Math.max(20, w - ind.length));
              state[`${cacheKey}_src`] = r.output;
              state[cacheKey] = mdLines;
            }
            for (const line of mdLines) {
              lines.push(truncLine(ind + line, w));
            }
          }
          if (options.expanded) lines.push("");
        }
        const budgeted = applyLineBudget(lines, options.expanded ?? false);
        lines.length = 0;
        lines.push(...budgeted);
      }
      text.setText(lines.join("\n"));
      return text;
    }
  });
  pi.on("session_shutdown", () => {
    for (const ticket of ticketRegistry.values()) {
      if (ticket.status === "running") {
        ticket.controller.abort();
        ticket.status = "cancelled";
        ticket.completedAt = Date.now();
      }
    }
  });
}
export {
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  DEFAULT_TOOLS,
  MAX_CONCURRENCY,
  READONLY_TOOLS,
  TOOL_FACTORIES,
  VALID_THINKING,
  agentPool,
  buildParentTranscript,
  buildSubagentSystemPrompt,
  clearAllModelOverrides,
  clearModelOverride,
  closePooledAgent,
  delegateExtension as default,
  deliverTicketResults,
  discoverAgents,
  extractOutput,
  extractTextContent,
  extractTouchedFromActivities,
  extractUsage,
  findAvailableAlternative,
  findProjectRoot,
  fmtDuration,
  fmtTokens,
  formatFailedTask,
  getActivityAge,
  getConcurrencyLimit,
  getHostDeps,
  getMaxAsyncTickets,
  getMaxConcurrent,
  handleCancel,
  handlePoll,
  indent,
  isSessionBusy,
  listPooledAgents,
  loadAgentFile,
  loadAgentsMdFiles,
  loadDelegateConfig,
  loadDelegateSettings,
  loadSkill,
  parseFrontmatter,
  readDelegateSettingsFile,
  removeConcurrencyModel,
  removeConcurrencyProvider,
  resetConcurrency,
  resetSessionOverrides,
  resolveCwd,
  resolveModel,
  resolveModelSpec,
  resolveToolGroups,
  runAgentSession,
  saveDelegateConfigAtomic,
  setConcurrencyDefault,
  setConcurrencyModel,
  setConcurrencyProvider,
  setDefaultModel,
  setMaxConcurrent,
  setModelOverride,
  shortenPath,
  sweepPool,
  sweepTickets,
  ticketRegistry,
  tree,
  trunc,
  truncLine,
  withSessionLock
};
