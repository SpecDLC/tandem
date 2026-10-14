// Public CI: every card is a member and every member has a card; schema accepts the example and rejects a wrong schema.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const Ajv = createRequire(import.meta.url)("ajv/dist/2020.js"); // ajv is installed outside the tree and found through NODE_PATH

const spec = readFileSync("spec/SPECIFICATION.md", "utf8");
const members = [...spec.matchAll(/^- \[([A-Z0-9-]+)\]\(\.\.\/cards\/\1\.md\)$/gm)].map((m) => m[1]);
const cards = readdirSync("cards").filter((f) => /^TANDEM-.*\.md$/.test(f)).map((f) => f.replace(/\.md$/, ""));
const errs = [];
for (const c of cards) if (!members.includes(c)) errs.push(`card ${c} is not a member`);
for (const m of members) if (!cards.includes(m)) errs.push(`member ${m} has no card`);
if (!members.length) errs.push("no members found");

const validate = new Ajv({ strict: false }).compile(JSON.parse(readFileSync("schema/tandem.tasks.v0.json", "utf8")));
const ok = { schema: "tandem.tasks/v0", tasks: [{ id: "optional-client-id", title: "Draft spec intro", estimate_pomodoros: 2, notes: "optional" }] };
if (!validate(ok)) errs.push("schema rejects the example payload");
if (validate({ ...ok, schema: "tandem.tasks/v1" })) errs.push("schema accepts a wrong schema");
if (validate({ tasks: ok.tasks })) errs.push("schema accepts a missing schema");
if (!/^# Session event profile\s+The session log is \*\*CloudEvents 1\.0\*\*/.test(readFileSync("profile/session-events.md", "utf8"))) errs.push("profile does not open with CloudEvents 1.0");
if (!/^# Tandem\s+The durable log is \*\*CloudEvents 1\.0\*\*/.test(readFileSync("README.md", "utf8"))) errs.push("README does not open with CloudEvents 1.0");

if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(`ok: ${cards.length} cards, ${members.length} members`);
