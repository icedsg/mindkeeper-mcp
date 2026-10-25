// Rebuilds examples/northwind-mindmap.json with the server's own functions, so the sample carries real history.
// Run after `npm run build`:  node examples/build-sample.mjs
// Uses a throwaway HOME, never your ~/.mindkeeper.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "mindkeeper-sample-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const mk = await import("../build/mindmap.js");

// January: 40 people from the CSV (manager column = CSV id)
const csv = readFileSync(join(here, "northwind-jan.csv"), "utf8");
const { ids } = await mk.importCsv(csv, undefined, "2026-01-05");
const id = (key) => ids[key];
const map = async () => JSON.parse(readFileSync(join(home, ".mindkeeper", "mindmap.json"), "utf8"));
const retitle = async (key, title, date) => {
  const n = (await map()).nodes[id(key)];
  await mk.addEntity(n.text, "person", n.parentId, { title }, undefined, date);
};

// Projects and who works on them (links beside the tree)
const atlas = await mk.addEntity("Atlas API", "project", id("daniel"), { status: "active" }, undefined, "2026-01-12");
const beacon = await mk.addEntity("Beacon mobile app", "project", id("tom"), { status: "active" }, undefined, "2026-01-12");
const insights = await mk.addEntity("Customer insights", "project", id("sofia"), { status: "active" }, undefined, "2026-02-02");
await mk.linkEntities(id("priya"), atlas.id, "leads", undefined, "2026-01-12");
await mk.linkEntities(id("liam"), atlas.id, "works on", undefined, "2026-01-12");
await mk.linkEntities(id("ines"), beacon.id, "works on", undefined, "2026-01-12");
await mk.linkEntities(id("felix"), beacon.id, "designs", undefined, "2026-01-20");
await mk.linkEntities(id("mei"), insights.id, "works on", undefined, "2026-02-02");
await mk.linkEntities(id("kenji"), insights.id, "sponsor", undefined, "2026-02-02");

// The year so far, each change with the date it really happened
await mk.deleteNode(id("ben"), "2026-03-31");
await mk.addEntity("Tariq Aziz", "person", id("sofia"), { title: "ML Engineer", start: "2026-03-02" }, undefined, "2026-03-02");
await retitle("liam", "Staff Engineer", "2026-04-01");
await mk.addEntity("Julia Costa", "person", id("tom"), { title: "Frontend Engineer", start: "2026-04-13" }, undefined, "2026-04-13");
await mk.addEntity("Sam Okoro", "person", id("noah"), { title: "People Partner", start: "2026-05-04" }, undefined, "2026-05-04");
await mk.deleteNode(id("nina"), "2026-05-15");
await mk.moveNode(id("sofia"), id("maya"), "2026-06-01");
await retitle("sofia", "VP Data", "2026-06-01");
await mk.moveNode(id("fatima"), id("laura"), "2026-06-01");
await retitle("elena", "VP Sales", "2026-07-01");

writeFileSync(join(here, "northwind-mindmap.json"), JSON.stringify(await map(), null, 2) + "\n");
const d = await mk.diffBetween("2026-01-31", "2026-07-31");
console.log(`wrote northwind-mindmap.json: joined ${d.joined.length}, left ${d.left.length}, moved ${d.moved.length}, renamed ${d.renamed.length}, changed ${d.changed?.length ?? 0}`);
rmSync(home, { recursive: true, force: true });
