# Tandem

The durable log is **CloudEvents 1.0**. A Tandem focus session writes one CloudEvents JSON object per line to a JSONL file you keep. Any other CloudEvents-aware log can read that file.

Tandem is a local-first focus session that a person and an agent drive through one command set. This repository is the public source: the contract and the material an agent needs to build a runtime. It is not an application.

## What is here

| Path | What |
|---|---|
| [spec/SPECIFICATION.md](spec/SPECIFICATION.md) | The specification `S:TANDEM-MVP-1` and its members |
| [cards/](cards/) | One falsifiable claim per file |
| [projections/connections.md](projections/connections.md) | How cards and the specification connect |
| [projections/requirements.md](projections/requirements.md) | Preferences, invariants, and bindings |
| [profile/session-events.md](profile/session-events.md) | The CloudEvents 1.0 profile for session events |
| [schema/tandem.tasks.v0.json](schema/tandem.tasks.v0.json) | JSON Schema for the task import payload |
| [templates/coach.md](templates/coach.md) | Optional "start my day" routine for an agent |
| [templates/sync.md](templates/sync.md) | Default sync path and schedule |
| [scripts/sync-jsonl.mjs](scripts/sync-jsonl.mjs) | Idempotent append of exported events to a JSONL file |
| [GUIDE.md](GUIDE.md) | How to build a runtime from the cards, and a walkthrough of one session from a person and from an agent, then the JSONL sync replay |
| [ROADMAP.md](ROADMAP.md) | Planned, shipped, and open behavior. Maintained by Texian. |

`cards/`, `spec/`, and `projections/` are generated from a ledger. Edit proposals belong in an issue, not in those files. [ROADMAP.md](ROADMAP.md) is maintained by hand.

## Start here

1. Read [spec/SPECIFICATION.md](spec/SPECIFICATION.md) and open any card it lists.
2. Follow the walkthrough in [GUIDE.md](GUIDE.md): a person and an agent each start a pomodoro and write the same kind of CloudEvent, then you sync the JSONL file and replay it. It needs Node 18 or later and nothing outside this repository. The templates are optional.
3. Run `node scripts/check.mjs` to check the cards, schema, and openings (it needs the `ajv` package).

License: MIT.

## Reference app

This repository also carries a reference runtime: `src/` (TypeScript, Vite, no UI framework), `public/`, `vendor/webmcp-polyfill/`, and its tests in `test/`. Engineering acceptance criteria are in [ac/](ac/).

```sh
npm ci && npm run typecheck && npm test && npm run build && npm run smoke
npm run witness      # interface witnesses against dist/
```
