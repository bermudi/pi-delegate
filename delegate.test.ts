import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
	parseFrontmatter,
	findProjectRoot,
	loadAgentFile,
	discoverAgents,
	buildParentTranscript,
	extractTextContent,
	loadSkill,
	resolveModel,
	extractOutput,
	extractUsage,
	fmtDuration,
	fmtTokens,
	trunc,
	tree,
	indent,
	shortenPath,
	getActivityAge,
	DEFAULT_TOOLS,
	VALID_THINKING,
	TOOL_FACTORIES,
	type AgentConfig,
} from "./delegate.ts";

// ── Integration test imports ──────────────────────────────────────────────

import { createTestSession, when, calls, says } from "@marcfargas/pi-test-harness";
import { resolve } from "node:path";

const EXTENSION = resolve(import.meta.dirname, "./delegate.ts");

type TestSession = Awaited<ReturnType<typeof createTestSession>>;

function getToolDef(ts: TestSession, name: string) {
	const runner = ts.session.extensionRunner;
	if (!runner) throw new Error("No extensionRunner on session");
	return runner.getToolDefinition(name);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(prefix = "delegate-test-"): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function cleanup(dir: string) {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeAgent(dir: string, filename: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, filename), content, "utf-8");
}

// ── parseFrontmatter ──────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
	test("parses YAML-ish frontmatter", () => {
		const content = `---
name: scout
description: A scout agent
---
You are a scout.
`;
		const result = parseFrontmatter(content);
		expect(result.data.name).toBe("scout");
		expect(result.data.description).toBe("A scout agent");
		expect(result.body).toBe("You are a scout.");
	});

	test("handles CRLF line endings", () => {
		const content = `---\r\nname: worker\r\ndescription: A worker\r\n---\r\nDo work.\r\n`;
		const result = parseFrontmatter(content);
		expect(result.data.name).toBe("worker");
		expect(result.body).toBe("Do work.");
	});

	test("returns empty data when no frontmatter", () => {
		const result = parseFrontmatter("Just body text.");
		expect(Object.keys(result.data)).toHaveLength(0);
		expect(result.body).toBe("Just body text.");
	});

	test("ignores lines without colon", () => {
		const content = `---
name: agent
bad line without colon
---
Body.
`;
		const result = parseFrontmatter(content);
		expect(result.data.name).toBe("agent");
		expect(result.data["bad line without colon"]).toBeUndefined();
	});

	test("trims keys and values", () => {
		const content = `---
  name  :   spaced agent  
---
Body.
`;
		const result = parseFrontmatter(content);
		expect(result.data.name).toBe("spaced agent");
	});

	test("handles empty body", () => {
		const content = `---
name: agent
description: desc
---
`;
		const result = parseFrontmatter(content);
		expect(result.body).toBe("");
	});
});

// ── findProjectRoot ───────────────────────────────────────────────────────

describe("findProjectRoot", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	test("finds .pi/agents directory", () => {
		const projectDir = path.join(tmpDir, "project");
		mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
		expect(findProjectRoot(projectDir)).toBe(projectDir);
	});

	test("walks up the directory tree", () => {
		const projectDir = path.join(tmpDir, "project");
		const nested = path.join(projectDir, "src", "deep");
		mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		expect(findProjectRoot(nested)).toBe(projectDir);
	});

	test("returns null when not found", () => {
		expect(findProjectRoot(tmpDir)).toBeNull();
	});

	test("stops at filesystem root", () => {
		expect(findProjectRoot("/")).toBeNull();
	});
});

// ── loadAgentFile ─────────────────────────────────────────────────────────

describe("loadAgentFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	test("returns null for non-existent file", () => {
		expect(loadAgentFile(path.join(tmpDir, "nonexistent.md"))).toBeNull();
	});

	test("parses a complete agent file", () => {
		const filePath = path.join(tmpDir, "scout.md");
		writeFileSync(filePath, `---
name: scout
description: Fast reconnaissance agent
model: anthropic/claude-haiku-4-5
thinking: low
tools: read, grep
skills: web-content
---
You are a scout. Be concise.
`);
		const cfg = loadAgentFile(filePath)!;
		expect(cfg.name).toBe("scout");
		expect(cfg.description).toBe("Fast reconnaissance agent");
		expect(cfg.model).toBe("anthropic/claude-haiku-4-5");
		expect(cfg.thinking).toBe("low");
		expect(cfg.tools).toEqual(["read", "grep"]);
		expect(cfg.skills).toEqual(["web-content"]);
		expect(cfg.systemPrompt).toBe("You are a scout. Be concise.");
	});

	test("defaults tools to DEFAULT_TOOLS when not specified", () => {
		const filePath = path.join(tmpDir, "minimal.md");
		writeFileSync(filePath, `---
name: minimal
description: Minimal agent
---
Prompt.
`);
		const cfg = loadAgentFile(filePath)!;
		expect(cfg.tools).toEqual(DEFAULT_TOOLS);
	});

	test("defaults thinking to off when invalid", () => {
		const filePath = path.join(tmpDir, "bad-thinking.md");
		writeFileSync(filePath, `---
name: bad-thinking
description: Bad thinking
thinking: super-duper-high
---
Prompt.
`);
		const cfg = loadAgentFile(filePath)!;
		expect(cfg.thinking).toBe("off");
	});

	test("returns null when name is missing", () => {
		const filePath = path.join(tmpDir, "no-name.md");
		writeFileSync(filePath, `---
description: No name here
---
Prompt.
`);
		expect(loadAgentFile(filePath)).toBeNull();
	});

	test("returns null when description is missing", () => {
		const filePath = path.join(tmpDir, "no-desc.md");
		writeFileSync(filePath, `---
name: no-desc
---
Prompt.
`);
		expect(loadAgentFile(filePath)).toBeNull();
	});

	test("trims and filters empty tools", () => {
		const filePath = path.join(tmpDir, "spaced-tools.md");
		writeFileSync(filePath, `---
name: spaced
description: Spaced tools
tools: read, , write , , grep
---
Prompt.
`);
		const cfg = loadAgentFile(filePath)!;
		expect(cfg.tools).toEqual(["read", "write", "grep"]);
	});
});

// ── discoverAgents ────────────────────────────────────────────────────────

describe("discoverAgents", () => {
	let tmpDir: string;
	let originalHomedir: () => string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		originalHomedir = os.homedir;
		mock.module("node:os", () => ({
			...os,
			homedir: () => tmpDir,
		}));
	});

	afterEach(() => {
		mock.module("node:os", () => os);
		cleanup(tmpDir);
	});

	test("discovers agents from user dir", () => {
		writeAgent(path.join(tmpDir, ".pi", "agent", "agents"), "user.md", `---
name: user-agent
description: User agent
---
Prompt.
`);
		const agents = discoverAgents("/nonexistent/project");
		expect(agents.has("user-agent")).toBe(true);
	});

	test("discovers agents from project dir", () => {
		const projectDir = path.join(tmpDir, "project");
		writeAgent(path.join(projectDir, ".pi", "agents"), "project.md", `---
name: project-agent
description: Project agent
---
Prompt.
`);
		const agents = discoverAgents(projectDir);
		expect(agents.has("project-agent")).toBe(true);
	});

	test("project agents override user agents by name", () => {
		writeAgent(path.join(tmpDir, ".pi", "agent", "agents"), "shared.md", `---
name: shared
description: User version
---
User prompt.
`);
		const projectDir = path.join(tmpDir, "project");
		writeAgent(path.join(projectDir, ".pi", "agents"), "shared.md", `---
name: shared
description: Project version
---
Project prompt.
`);
		const agents = discoverAgents(projectDir);
		expect(agents.get("shared")!.description).toBe("Project version");
	});

	test("skips .chain.md files", () => {
		writeAgent(path.join(tmpDir, ".pi", "agent", "agents"), "chain.chain.md", `---
name: chain
description: Chain agent
---
Prompt.
`);
		const agents = discoverAgents("/nonexistent");
		expect(agents.has("chain")).toBe(false);
	});

	test("skips non-markdown files", () => {
		const dir = path.join(tmpDir, ".pi", "agent", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "readme.txt"), `---
name: txt
description: TXT
---
Prompt.
`);
		const agents = discoverAgents("/nonexistent");
		expect(agents.has("txt")).toBe(false);
	});

	test("returns empty map when no agents found", () => {
		const agents = discoverAgents("/nonexistent");
		expect(agents.size).toBe(0);
	});
});

// ── buildParentTranscript ─────────────────────────────────────────────────

describe("buildParentTranscript", () => {
	test("returns null on empty entries", () => {
		expect(buildParentTranscript([], null)).toBeNull();
	});

	test("formats user and assistant messages", () => {
		const entries = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: { role: "user", content: [{ type: "text", text: "Hello" }] },
			},
			{
				type: "message",
				id: "2",
				parentId: "1",
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
			},
		] as any[];
		const result = buildParentTranscript(entries, undefined);
		expect(result).toContain("**User:** Hello");
		expect(result).toContain("**Assistant:** Hi there");
	});

	test("filters out non-text content blocks", () => {
		const entries = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "user",
					content: [
						{ type: "image", source: "data:image/png;base64,abc" },
						{ type: "text", text: "Describe this image" },
					],
				},
			},
		] as any[];
		const result = buildParentTranscript(entries, undefined);
		expect(result).toBe("**User:** Describe this image");
	});

	test("returns null when buildSessionContext throws", () => {
		// Invalid entries should cause buildSessionContext to throw
		const result = buildParentTranscript(null as any, null);
		expect(result).toBeNull();
	});
});

// ── extractTextContent ────────────────────────────────────────────────────

describe("extractTextContent", () => {
	test("returns string content as-is", () => {
		expect(extractTextContent("hello")).toBe("hello");
	});

	test("extracts text blocks from array", () => {
		expect(
			extractTextContent([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		).toBe("helloworld");
	});

	test("skips non-text blocks", () => {
		expect(
			extractTextContent([
				{ type: "image", source: "base64" },
				{ type: "text", text: "only text" },
			]),
		).toBe("only text");
	});

	test("skips text blocks without string text", () => {
		expect(
			extractTextContent([
				{ type: "text" },
				{ type: "text", text: "valid" },
				{ type: "text", text: 123 as any },
			]),
		).toBe("valid");
	});

	test("returns empty string for non-array non-string", () => {
		expect(extractTextContent(123 as any)).toBe("");
		expect(extractTextContent(null as any)).toBe("");
	});
});

// ── loadSkill ─────────────────────────────────────────────────────────────

describe("loadSkill", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		mock.module("node:os", () => ({
			...os,
			homedir: () => tmpDir,
		}));
	});

	afterEach(() => {
		mock.module("node:os", () => os);
		cleanup(tmpDir);
	});

	test("loads skill from project .agents/skills/", () => {
		const skillDir = path.join(tmpDir, ".agents", "skills", "web-content");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(path.join(skillDir, "SKILL.md"), "# Web Content\nSearch the web.", "utf-8");
		expect(loadSkill("web-content", tmpDir)).toBe("# Web Content\nSearch the web.");
	});

	test("loads skill from project .pi/skills/", () => {
		const skillDir = path.join(tmpDir, ".pi", "skills", "custom");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(path.join(skillDir, "SKILL.md"), "Custom skill.", "utf-8");
		expect(loadSkill("custom", tmpDir)).toBe("Custom skill.");
	});

	test("returns null when skill not found", () => {
		expect(loadSkill("nonexistent", tmpDir)).toBeNull();
	});

	test("searches user dirs after project dirs", () => {
		// Project dir has no skill
		// User dir has it
		const userSkillDir = path.join(tmpDir, ".pi", "agent", "skills", "shared");
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(path.join(userSkillDir, "SKILL.md"), "User skill.", "utf-8");
		expect(loadSkill("shared", tmpDir)).toBe("User skill.");
	});
});

// ── resolveModel ──────────────────────────────────────────────────────────

describe("resolveModel", () => {
	const parentModel = { provider: "anthropic", id: "claude-sonnet-4" } as any;

	function makeRegistry(models: Array<{ provider: string; id: string }>) {
		return {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) ?? null,
		} as any;
	}

	test("returns parent model when spec is undefined", () => {
		expect(resolveModel(undefined, makeRegistry([]), parentModel)).toBe(parentModel);
	});

	test("finds bare id in available models", () => {
		const registry = makeRegistry([
			{ provider: "openai", id: "gpt-5" },
			{ provider: "anthropic", id: "claude-haiku-4-5" },
		]);
		const result = resolveModel("gpt-5", registry, parentModel);
		expect(result).toEqual({ provider: "openai", id: "gpt-5" });
	});

	test("finds provider/id spec", () => {
		const registry = makeRegistry([
			{ provider: "openai", id: "gpt-5" },
		]);
		const result = resolveModel("openai/gpt-5", registry, parentModel);
		expect(result).toEqual({ provider: "openai", id: "gpt-5" });
	});

	test("returns undefined when bare id not found", () => {
		const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
		expect(resolveModel("nonexistent", registry, parentModel)).toBeUndefined();
	});

	test("returns undefined when provider/id not found", () => {
		const registry = makeRegistry([{ provider: "openai", id: "gpt-5" }]);
		expect(resolveModel("anthropic/claude-sonnet-4", registry, parentModel)).toBeUndefined();
	});

	test("handles spec with multiple slashes gracefully", () => {
		const registry = makeRegistry([{ provider: "openrouter", id: "qwen/qwen3-coder" }]);
		const result = resolveModel("openrouter/qwen/qwen3-coder", registry, parentModel);
		expect(result).toEqual({ provider: "openrouter", id: "qwen/qwen3-coder" });
	});
});

// ── extractOutput ─────────────────────────────────────────────────────────

describe("extractOutput", () => {
	test("extracts text from assistant messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
		] as any;
		expect(extractOutput(messages)).toBe("hello\n\nworld");
	});

	test("ignores non-assistant messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "system", content: [{ type: "text", text: "sys" }] },
		] as any;
		expect(extractOutput(messages)).toBe("");
	});

	test("ignores non-text blocks", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "tool_use", name: "bash" }, { type: "text", text: "result" }] },
		] as any;
		expect(extractOutput(messages)).toBe("result");
	});

	test("handles string content", () => {
		const messages = [{ role: "assistant", content: "plain string" }] as any;
		expect(extractOutput(messages)).toBe("");
	});
});

// ── extractUsage ──────────────────────────────────────────────────────────

describe("extractUsage", () => {
	test("sums usage across assistant messages", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "hello" }], usage: { input: 10, output: 5, total: 15 } },
			{ role: "assistant", content: [{ type: "text", text: "world" }], usage: { input: 8, output: 4, total: 12 } },
		] as any;
		expect(extractUsage(messages)).toEqual({ input: 18, output: 9, cacheRead: 0, total: 27 });
	});

	test("falls back to input+output when total missing", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 3, output: 2 } },
		] as any;
		expect(extractUsage(messages)).toEqual({ input: 3, output: 2, cacheRead: 0, total: 5 });
	});

	test("includes cacheRead when present", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 10, output: 5, cacheRead: 20, total: 35 } },
		] as any;
		expect(extractUsage(messages)).toEqual({ input: 10, output: 5, cacheRead: 20, total: 35 });
	});

	test("returns zeros for no messages", () => {
		expect(extractUsage([])).toEqual({ input: 0, output: 0, cacheRead: 0, total: 0 });
	});

	test("ignores messages without usage", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		] as any;
		expect(extractUsage(messages)).toEqual({ input: 0, output: 0, cacheRead: 0, total: 0 });
	});
});

// ── Formatting utilities ──────────────────────────────────────────────────

describe("fmtDuration", () => {
	test("formats milliseconds", () => {
		expect(fmtDuration(500)).toBe("500ms");
		expect(fmtDuration(999)).toBe("999ms");
	});

	test("formats seconds", () => {
		expect(fmtDuration(1000)).toBe("1.0s");
		expect(fmtDuration(5500)).toBe("5.5s");
		expect(fmtDuration(59999)).toBe("60.0s");
	});

	test("formats minutes and seconds", () => {
		expect(fmtDuration(60000)).toBe("1m0s");
		expect(fmtDuration(125000)).toBe("2m5s");
		expect(fmtDuration(3600000)).toBe("60m0s");
	});
});

describe("fmtTokens", () => {
	test("returns raw number under 1000", () => {
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(999)).toBe("999");
	});

	test("formats with one decimal between 1k and 10k", () => {
		expect(fmtTokens(1000)).toBe("1.0k");
		expect(fmtTokens(5500)).toBe("5.5k");
		expect(fmtTokens(9999)).toBe("10.0k");
	});

	test("rounds above 10k", () => {
		expect(fmtTokens(10000)).toBe("10k");
		expect(fmtTokens(15500)).toBe("16k");
	});
});

describe("trunc", () => {
	test("returns short strings unchanged", () => {
		expect(trunc("hello", 10)).toBe("hello");
	});

	test("truncates long strings with ellipsis", () => {
		expect(trunc("hello world", 8)).toBe("hello w…");
	});

	test("handles exact length", () => {
		expect(trunc("hello", 5)).toBe("hello");
	});
});

describe("tree", () => {
	test("returns ├─ for non-last items", () => {
		expect(tree(0, 3)).toBe("├─");
		expect(tree(1, 3)).toBe("├─");
	});

	test("returns └─ for last item", () => {
		expect(tree(2, 3)).toBe("└─");
		expect(tree(0, 1)).toBe("└─");
	});
});

describe("indent", () => {
	test("returns │   for non-last items", () => {
		expect(indent(0, 3)).toBe("│  ");
	});

	test("returns three spaces for last item", () => {
		expect(indent(2, 3)).toBe("   ");
	});
});

// ── shortenPath ──────────────────────────────────────────────────────────

describe("shortenPath", () => {
	test("replaces HOME with ~", () => {
		const home = process.env.HOME;
		if (home && home !== "/") {
			expect(shortenPath(home)).toBe("~");
			expect(shortenPath(home + "/projects/my-app")).toBe("~/projects/my-app");
		}
	});

	test("does not match overlapping home prefixes", () => {
		const home = process.env.HOME;
		if (home && home !== "/") {
			// /home/alice should not match /home/alice2/file
			expect(shortenPath(home + "2/file")).toBe(home + "2/file");
		}
	});

	test("handles trailing slash in HOME", () => {
		const homeRaw = process.env.HOME;
		if (homeRaw && homeRaw !== "/") {
			const homeWithSlash = homeRaw.endsWith("/") ? homeRaw : homeRaw + "/";
			// shortenPath reads from process.env.HOME, not the argument,
			// so we test that HOME with or without trailing slash works
			expect(shortenPath(homeRaw + "/project")).toContain("~/project");
		}
	});

	test("returns non-home paths unchanged", () => {
		expect(shortenPath("/usr/local/bin")).toBe("/usr/local/bin");
		expect(shortenPath("/tmp/stuff")).toBe("/tmp/stuff");
	});
});

// ── getActivityAge ───────────────────────────────────────────────────────

describe("getActivityAge", () => {
	test("returns empty for undefined", () => {
		expect(getActivityAge(undefined)).toBe("");
	});

	test("returns active now for recent activity", () => {
		expect(getActivityAge(Date.now())).toBe("active now");
		expect(getActivityAge(Date.now() - 500)).toBe("active now");
	});

	test("returns seconds ago", () => {
		const result = getActivityAge(Date.now() - 5000);
		expect(result).toMatch(/^active \d+s ago$/);
	});

	test("returns minutes ago", () => {
		const result = getActivityAge(Date.now() - 120000);
		expect(result).toMatch(/^active \d+m ago$/);
	});

	test("clamps future timestamps to active now", () => {
		// Clock skew or backdated timers should not produce negative ages
		expect(getActivityAge(Date.now() + 60_000)).toBe("active now");
	});

	test("boundary: 999ms is active now, 1000ms is seconds", () => {
		expect(getActivityAge(Date.now() - 999)).toBe("active now");
		expect(getActivityAge(Date.now() - 1000)).toMatch(/^active \d+s ago$/);
	});
});

// ── Constants ─────────────────────────────────────────────────────────────

describe("constants", () => {
	test("DEFAULT_TOOLS has 7 entries", () => {
		expect(DEFAULT_TOOLS).toHaveLength(7);
		expect(DEFAULT_TOOLS).toContain("read");
		expect(DEFAULT_TOOLS).toContain("bash");
		expect(DEFAULT_TOOLS).toContain("edit");
		expect(DEFAULT_TOOLS).toContain("write");
		expect(DEFAULT_TOOLS).toContain("grep");
		expect(DEFAULT_TOOLS).toContain("find");
		expect(DEFAULT_TOOLS).toContain("ls");
	});

	test("VALID_THINKING contains all expected levels", () => {
		expect(VALID_THINKING.has("off")).toBe(true);
		expect(VALID_THINKING.has("minimal")).toBe(true);
		expect(VALID_THINKING.has("low")).toBe(true);
		expect(VALID_THINKING.has("medium")).toBe(true);
		expect(VALID_THINKING.has("high")).toBe(true);
		expect(VALID_THINKING.has("xhigh")).toBe(true);
		expect(VALID_THINKING.has("invalid")).toBe(false);
	});

	test("TOOL_FACTORIES has factory for each DEFAULT_TOOL", () => {
		for (const name of DEFAULT_TOOLS) {
			expect(TOOL_FACTORIES[name]).toBeFunction();
		}
	});
});

// ── Integration: tool registration ────────────────────────────────────────

describe("delegate extension integration", () => {
	let ts: TestSession | undefined;

	afterEach(() => {
		ts?.dispose();
		ts = undefined;
	});

	test("registers the delegate tool", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		expect(toolDef).toBeDefined();
		expect(toolDef!.name).toBe("delegate");
		expect(toolDef!.label).toBe("Delegate");
		expect(toolDef!.description).toContain("subagent");
	});

	test("has tasks array parameter with minItems 0 (allows help mode)", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const schema = toolDef!.parameters as any;
		expect(schema.type).toBe("object");
		expect(schema.properties.tasks.type).toBe("array");
		expect(schema.properties.tasks.minItems).toBe(0);
	});

	test("promptSnippet and promptGuidelines are set", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		expect(toolDef!.promptSnippet).toBeDefined();
		expect(toolDef!.promptSnippet).toContain("subagent");
		expect(toolDef!.promptGuidelines).toBeDefined();
		expect(toolDef!.promptGuidelines.length).toBeGreaterThanOrEqual(2);
	});

	test("execute returns help when tasks is empty", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");

		const result = await toolDef!.execute(
			"tc-help",
			{ tasks: [] },
			undefined,
			undefined,
			ts.session.extensionRunner as any,
		);

		const text = result.content[0].text;
		expect(text).toContain("Delegate Help");
		expect(text).toContain("Available Agents");
		expect(text).toContain("Task Fields");
		expect(text).toContain("```markdown");
	});

	test("task schema has prompt as required string", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const taskSchema = (toolDef!.parameters as any).properties.tasks.items;
		expect(taskSchema.type).toBe("object");
		expect(taskSchema.properties.prompt.type).toBe("string");
		expect(taskSchema.required).toContain("prompt");
	});

	test("task schema has optional fields", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const taskSchema = (toolDef!.parameters as any).properties.tasks.items;
		const optionalFields = ["agent", "model", "skills", "tools", "thinking", "systemPrompt", "cwd", "context"];
		for (const field of optionalFields) {
			expect(taskSchema.properties[field]).toBeDefined();
		}
		expect(taskSchema.required).toEqual(["prompt"]);
	});

	test("execute rejects unknown agents and suggests help", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");

		const result = await toolDef!.execute(
			"tc-1",
			{ tasks: [{ prompt: "do something", agent: "nonexistent-agent-xyz" }] },
			undefined,
			undefined,
			ts.session.extensionRunner as any,
		);

		const text = result.content[0].text;
		expect(text).toContain("Unknown agent");
		expect(text).toContain("nonexistent-agent-xyz");
		expect(text).toContain("Call delegate with no tasks for full help");
	});

	test("execute throws when no system prompt and no agent", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");

		await expect(
			toolDef!.execute(
				"tc-2",
				{ tasks: [{ prompt: "do something" }] },
				undefined,
				undefined,
				ts.session.extensionRunner as any,
			),
		).rejects.toThrow("no system prompt");
	});
});

// ── Integration: renderers ────────────────────────────────────────────────

describe("delegate renderers", () => {
	let ts: TestSession | undefined;

	afterEach(() => {
		ts?.dispose();
		ts = undefined;
	});

	function mockTheme() {
		return {
			fg: (_key: string, text: string) => text,
			bold: (text: string) => `**${text}**`,
		} as any;
	}

	function createMockText() {
		let captured = "";
		return {
			setText: (text: string) => { captured = text; },
			getText: () => captured,
			invalidate: () => {},
		};
	}

	function mockRenderCtx(overrides: any = {}) {
		return {
			state: {},
			executionStarted: false,
			lastComponent: createMockText(),
			invalidate: () => {},
			...overrides,
		} as any;
	}

	test("renderCall shows task count", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const text = toolDef!.renderCall({ tasks: [{ prompt: "task 1" }, { prompt: "task 2" }] }, theme, ctx);
		expect((text as any).getText()).toContain("delegate 2 tasks");
	});

	test("renderCall shows agent name when provided", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const text = toolDef!.renderCall({ tasks: [{ prompt: "do work", agent: "worker" }] }, theme, ctx);
		expect((text as any).getText()).toContain("**worker**");
	});

	test("renderCall truncates long prompts", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const longPrompt = "a".repeat(100);
		const text = toolDef!.renderCall({ tasks: [{ prompt: longPrompt }] }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered.length).toBeLessThan(longPrompt.length + 50);
		expect(rendered).toContain("…");
	});

	test("renderResult shows progress when partial", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Running..." }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [],
				progress: [{ index: 0, agent: "inline", task: "task", status: "running", durationMs: 0, tokens: 0, toolUses: 0, activities: [] }],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: true, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("Running 1 subagent");
		expect(rendered).toContain("●");
	});

	test("renderResult shows done status when complete", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "result", durationMs: 1200, tokens: 42 }],
				progress: [{ index: 0, agent: "inline", task: "task", status: "done", durationMs: 1200, tokens: 42, toolUses: 1, activities: [] }],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("✓");
		expect(rendered).toContain("1/1 completed");
	});

	test("renderResult truncates output to 3 lines when not expanded", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "line1\nline2\nline3\nline4\nline5", durationMs: 0, tokens: 0 }],
				progress: [{ index: 0, agent: "inline", task: "task", status: "done", durationMs: 0, tokens: 0, toolUses: 0, activities: [] }],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("… 2 more lines");
	});

	test("renderResult shows all lines when expanded", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "line1\nline2\nline3\nline4\nline5", durationMs: 0, tokens: 0 }],
				progress: [{ index: 0, agent: "inline", task: "task", status: "done", durationMs: 0, tokens: 0, toolUses: 0, activities: [] }],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: true }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).not.toContain("more lines");
		expect(rendered).toContain("line5");
	});

	test("renderResult shows running tool activities in partial mode", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Running..." }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "running",
					durationMs: 500, tokens: 120, toolUses: 2,
					activities: [
						{ id: "tc1", name: "read", args: { path: "src/config.ts" }, startTime: 0, endTime: 100 },
						{ id: "tc2", name: "bash", args: { command: "git status" }, startTime: 150 },
					],
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: true, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("→ read src/config.ts");
		expect(rendered).toContain("→ $ git status");
	});

	test("renderResult shows completed tool results in final mode", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "all good", durationMs: 1000, tokens: 200 }],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "done",
					durationMs: 1000, tokens: 200, toolUses: 1,
					activities: [
						{
							id: "tc1", name: "read", args: { path: "src/config.ts" },
							startTime: 0, endTime: 100,
							result: { content: [{ type: "text", text: "line1\nline2\nline3" }], isError: false },
						},
					],
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("→ read src/config.ts");
		expect(rendered).toContain("✓");
		expect(rendered).toContain("line1");
		expect(rendered).toContain("… 2 more lines");
	});

	test("renderResult expands tool results when expanded is true", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "done", durationMs: 1000, tokens: 200 }],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "done",
					durationMs: 1000, tokens: 200, toolUses: 1,
					activities: [
						{
							id: "tc1", name: "read", args: { path: "src/config.ts" },
							startTime: 0, endTime: 100,
							result: { content: [{ type: "text", text: "alpha\nbeta\ngamma" }], isError: false },
						},
					],
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: true }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).toContain("gamma");
		expect(rendered).not.toContain("more lines");
	});

	test("renderResult shows error icon for failed tool results", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "", error: "bad cmd", durationMs: 500, tokens: 50 }],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "failed",
					durationMs: 500, tokens: 50, toolUses: 1,
					activities: [
						{
							id: "tc1", name: "bash", args: { command: "bad-cmd" },
							startTime: 0, endTime: 50,
							result: { content: [{ type: "text", text: "not found" }], isError: true },
						},
					],
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("→ $ bad-cmd");
		expect(rendered).toContain("✗");
	});

	test("renderResult shows activities for completed subagent in partial mode", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Running..." }],
			details: {
				tasks: [{ prompt: "task" }, { prompt: "task2" }],
				results: [],
				progress: [
					{
						index: 0, agent: "inline", task: "task", status: "done",
						durationMs: 1000, tokens: 500, toolUses: 2,
						activities: [
							{ id: "tc1", name: "read", args: { path: "a.ts" }, startTime: 0, endTime: 50, result: { content: [{ type: "text", text: "ok" }], isError: false } },
						],
					},
					{
						index: 1, agent: "inline", task: "task2", status: "running",
						durationMs: 500, tokens: 100, toolUses: 1,
						activities: [
							{ id: "tc2", name: "bash", args: { command: "ls" }, startTime: 0 },
						],
					},
				],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: true, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		// Done subagent should still show its activities
		expect(rendered).toContain("→ read a.ts");
		// Running subagent shows its activities
		expect(rendered).toContain("→ $ ls");
		// Tree uses ├ for non-last item
		expect(rendered).toContain("├─");
	});

	test("partial render shows last 3 activities when more than 3", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const activities = [
			{ id: "tc1", name: "read", args: { path: "1.ts" }, startTime: 0, endTime: 10, result: { content: [{ type: "text", text: "a" }], isError: false } },
			{ id: "tc2", name: "read", args: { path: "2.ts" }, startTime: 20, endTime: 30, result: { content: [{ type: "text", text: "b" }], isError: false } },
			{ id: "tc3", name: "read", args: { path: "3.ts" }, startTime: 40, endTime: 50, result: { content: [{ type: "text", text: "c" }], isError: false } },
			{ id: "tc4", name: "read", args: { path: "4.ts" }, startTime: 60 },
		];

		const result = {
			content: [{ type: "text", text: "Running..." }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "running",
					durationMs: 500, tokens: 100, toolUses: 4,
					activities,
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: true, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		// Should show last 3 (2.ts, 3.ts, 4.ts) but not 1.ts
		expect(rendered).toContain("2.ts");
		expect(rendered).toContain("3.ts");
		expect(rendered).toContain("4.ts");
		expect(rendered).not.toContain("1.ts");
	});

	test("formatToolCallShort: various tool types render correctly", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const activities = [
			{ id: "t1", name: "read", args: { path: "src/file.ts", offset: 10, limit: 5 }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "x" }], isError: false } },
			{ id: "t1b", name: "read", args: { file_path: "alt.ts" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "x" }], isError: false } },
			{ id: "t2", name: "write", args: { path: "out.ts", content: "line1\nline2\nline3" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "ok" }], isError: false } },
			{ id: "t3", name: "edit", args: { path: "fix.ts" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "done" }], isError: false } },
			{ id: "t4", name: "ls", args: { path: "/tmp" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "files" }], isError: false } },
			{ id: "t5", name: "grep", args: { pattern: "TODO", path: "src" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "matches" }], isError: false } },
			{ id: "t5b", name: "grep", args: { path: "src" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "matches" }], isError: false } },
			{ id: "t6", name: "find", args: { pattern: "*.ts", path: "." }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "found" }], isError: false } },
			{ id: "t7", name: "bash", args: { command: "git status" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "clean" }], isError: false } },
			{ id: "t8", name: "custom_tool", args: { query: "search term" }, startTime: 0, endTime: 1, result: { content: [{ type: "text", text: "custom" }], isError: false } },
		];

		const result = {
			content: [{ type: "text", text: "Done" }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [{ agent: "inline", output: "ok", durationMs: 100, tokens: 50 }],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "done",
					durationMs: 100, tokens: 50, toolUses: 10,
					activities,
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: false, expanded: true }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("read src/file.ts:10-14");
		expect(rendered).toContain("write out.ts (3 lines)");
		expect(rendered).toContain("edit fix.ts");
		expect(rendered).toContain("ls /tmp");
		expect(rendered).toContain("grep /TODO/ in src");
		expect(rendered).toContain("find *.ts in .");
		expect(rendered).toContain("$ git status");
		expect(rendered).toContain("custom_tool search term");
	});

	test("renderResult shows activity age for running tasks", async () => {
		ts = await createTestSession({ extensions: [EXTENSION] });
		const toolDef = getToolDef(ts, "delegate");
		const theme = mockTheme();
		const ctx = mockRenderCtx();

		const result = {
			content: [{ type: "text", text: "Running..." }],
			details: {
				tasks: [{ prompt: "task" }],
				results: [],
				progress: [{
					index: 0, agent: "inline", task: "task", status: "running",
					durationMs: 5000, tokens: 200, toolUses: 3,
					lastActivityAt: Date.now() - 3000,
					activities: [
						{ id: "tc1", name: "read", args: { path: "src/x.ts" }, startTime: Date.now() - 3000, endTime: Date.now() - 2500, result: { content: [{ type: "text", text: "ok" }], isError: false } },
					],
				}],
			},
		};

		const text = toolDef!.renderResult(result, { isPartial: true, expanded: false }, theme, ctx);
		const rendered = (text as any).getText();
		expect(rendered).toContain("●");
		expect(rendered).toContain("active ");
		expect(rendered).toContain("s ago");
	});
});
