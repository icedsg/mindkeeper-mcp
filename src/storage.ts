import { readFile, writeFile, copyFile, rename, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Mindmap, MindkeeperConfig, GistCloudConfig } from "./types.js";

const DIR = join(homedir(), ".mindkeeper");
const FILE = join(DIR, "mindmap.json");
const BACKUP = join(DIR, "mindmap.json.bak");
const TMP = join(DIR, "mindmap.json.tmp");
const CONFIG_FILE = join(DIR, "config.json");

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

export async function loadConfig(): Promise<MindkeeperConfig> {
  await ensureDirectory();
  if (!existsSync(CONFIG_FILE)) return {};
  const raw = await readFile(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as MindkeeperConfig;
}

export async function saveConfig(config: MindkeeperConfig): Promise<void> {
  await ensureDirectory();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

interface GistFile {
  content: string;
}

interface GistResponse {
  id: string;
  html_url: string;
  files: Record<string, GistFile>;
}

export async function pushToGist(
  mindmap: Mindmap,
  cfg: GistCloudConfig
): Promise<{ gistId: string; url: string }> {
  const content = JSON.stringify(mindmap, null, 2);
  const headers: Record<string, string> = {
    Authorization: `token ${cfg.token}`,
    "Content-Type": "application/json",
    "User-Agent": "mindkeeper-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const body = JSON.stringify({
    description: "mindkeeper-mcp backup",
    public: false,
    files: { "mindmap.json": { content } },
  });

  let res: Response;
  if (cfg.gistId) {
    res = await fetch(`https://api.github.com/gists/${cfg.gistId}`, {
      method: "PATCH",
      headers,
      body,
    });
  } else {
    res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers,
      body,
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Gist API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as GistResponse;
  return { gistId: data.id, url: data.html_url };
}

export async function pullFromGist(cfg: GistCloudConfig): Promise<Mindmap> {
  if (!cfg.gistId) throw new Error("No gistId in config — push first");

  const res = await fetch(`https://api.github.com/gists/${cfg.gistId}`, {
    headers: {
      Authorization: `token ${cfg.token}`,
      "User-Agent": "mindkeeper-mcp",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Gist API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as GistResponse;
  const file = data.files["mindmap.json"];
  if (!file) throw new Error('mindmap.json not found in gist');
  return JSON.parse(file.content) as Mindmap;
}
