/**
 * Move old pi-delegate sessions out of Pi's normal session index.
 *
 * This is intentionally a standalone migration, not extension startup code:
 * `pi -r` indexes sessions before extensions are loaded.
 *
 * Usage:
 *   bun run migrate-delegate-sessions.ts          # report only
 *   bun run migrate-delegate-sessions.ts --apply  # unlink and move
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

const agentDir = getAgentDir();
const sourceDir = path.join(agentDir, "sessions");
const destinationDir = path.join(agentDir, "delegate-sessions");
const apply = process.argv.includes("--apply");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function readSession(file: string): JsonObject[] | undefined {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const entries: JsonObject[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) return undefined;
      entries.push(parsed);
    }
    return entries;
  } catch {
    return undefined;
  }
}

function readSessionHeader(file: string): JsonObject | undefined {
  try {
    const firstLine = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
    const parsed: unknown = JSON.parse(firstLine);
    return isObject(parsed) && parsed.type === "session" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sessionHeader(entries: JsonObject[]): JsonObject | undefined {
  const header = entries[0];
  return header?.type === "session" ? header : undefined;
}

function entryKey(entry: JsonObject): string {
  return JSON.stringify(entry);
}

/**
 * Pi's forkFrom() copies every non-header entry from the source session before
 * writing anything new. Old delegate sessions do not copy the parent history.
 * This is the discriminator: parentSession by itself is deliberately not
 * sufficient because genuine Pi forks also have it.
 */
function isPiFork(
  childEntries: JsonObject[],
  parentEntries: JsonObject[],
): boolean {
  const childBody = childEntries.slice(1);
  const parentBody = parentEntries.slice(1);
  if (parentBody.length === 0 || childBody.length < parentBody.length) {
    return false;
  }
  return parentBody.every(
    (entry, index) => entryKey(entry) === entryKey(childBody[index]),
  );
}

function findJsonlFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(candidate);
    }
  };
  visit(directory);
  return files;
}

interface MigrationCandidate {
  source: string;
  destination: string;
}

const candidates: MigrationCandidate[] = [];
let skipped = 0;
const parentCache = new Map<string, JsonObject[] | undefined>();

for (const file of findJsonlFiles(sourceDir)) {
  const header = readSessionHeader(file);
  const parent = header?.parentSession;
  if (!header || typeof parent !== "string") continue;

  const parentPath = path.resolve(parent);
  if (!isWithin(sourceDir, parentPath) || !fs.existsSync(parentPath)) {
    skipped++;
    console.warn(`skip (parent unavailable): ${file}`);
    continue;
  }

  let parentEntries = parentCache.get(parentPath);
  if (parentEntries === undefined && !parentCache.has(parentPath)) {
    parentEntries = readSession(parentPath);
    parentCache.set(parentPath, parentEntries);
  }
  const entries = readSession(file);
  if (!entries) {
    skipped++;
    console.warn(`skip (invalid session): ${file}`);
    continue;
  }
  if (!parentEntries || isPiFork(entries, parentEntries)) continue;

  const relative = path.relative(sourceDir, file);
  candidates.push({
    source: file,
    destination: path.join(destinationDir, relative),
  });
}

console.log(
  `${apply ? "Migrating" : "Found"} ${candidates.length} delegate session(s); ` +
    `${skipped} skipped because their parent could not be verified.`,
);

if (!apply) {
  for (const candidate of candidates) {
    console.log(`would move: ${candidate.source} -> ${candidate.destination}`);
  }
  console.log("Nothing changed. Re-run with --apply to perform the migration.");
  process.exit(0);
}

let moved = 0;
for (const candidate of candidates) {
  const entries = readSession(candidate.source);
  const header = entries && sessionHeader(entries);
  if (!entries || !header) {
    console.warn(`skip (changed during migration): ${candidate.source}`);
    continue;
  }

  delete header.parentSession;
  const parent = path.dirname(candidate.destination);
  fs.mkdirSync(parent, { recursive: true });

  const temporary = `${candidate.source}.delegate-migration-${process.pid}.tmp`;
  try {
    if (fs.existsSync(candidate.destination)) {
      throw new Error("destination already exists");
    }
    fs.writeFileSync(
      temporary,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    fs.renameSync(temporary, candidate.source);
    fs.renameSync(candidate.source, candidate.destination);
    console.log(`moved: ${candidate.source} -> ${candidate.destination}`);
    moved++;
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Preserve the original error below; the temp file is harmless and
      // uniquely named for this process.
    }
    console.error(
      `failed: ${candidate.source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

console.log(`Moved ${moved}/${candidates.length} delegate session(s).`);
