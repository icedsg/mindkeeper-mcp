import { readFile, writeFile, copyFile, rename, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Mindmap } from "./types.js";

const DIR = join(homedir(), ".mindkeeper");
const FILE = join(DIR, "mindmap.json");
const BACKUP = join(DIR, "mindmap.json.bak");
const TMP = join(DIR, "mindmap.json.tmp");

const EMPTY: Mindmap = { nodes: {}, rootId: null };

export async function ensureDirectory(): Promise<void> {
  if (!existsSync(DIR)) {
    await mkdir(DIR, { recursive: true });
  }
}

export async function loadMindmap(): Promise<Mindmap> {
  await ensureDirectory();
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  const raw = await readFile(FILE, "utf-8");
  return JSON.parse(raw) as Mindmap;
}

export async function saveMindmap(mindmap: Mindmap): Promise<void> {
  await ensureDirectory();
  // Write to temp, backup current, then atomically replace
  await writeFile(TMP, JSON.stringify(mindmap, null, 2), "utf-8");
  if (existsSync(FILE)) {
    await copyFile(FILE, BACKUP);
    await unlink(FILE);
  }
  await rename(TMP, FILE);
}
