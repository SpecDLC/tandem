// In-memory tandem sync v1 endpoint. One process, one log, no disk.
// It checks JSON shape and id only. It does not check type, actor, data, or time.
import { createServer } from "node:http";

const CONTRACT = "tandem.sync";

function isNonEmptyId(item) {
  return typeof item === "object" && item !== null && !Array.isArray(item)
    && typeof item.id === "string" && item.id.length > 0;
}

function parseSince(raw) {
  if (raw === null || raw === "") return 0;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * @param {{ maxLimit?: number, version?: number, rejectV1?: boolean }} [options]
 * `version` is the /v1/info version. `rejectV1` answers every /v1/ path with 404.
 */
export async function startSyncEndpoint(options = {}) {
  const maxLimit = options.maxLimit ?? 100;
  const infoVersion = options.version ?? 1;
  const rejectV1 = options.rejectV1 === true;
  /** @type {{ seq: number, id: string, event: object }[]} */
  const records = [];
  const byId = new Map();
  let nextSeq = 1;

  const send = (res, status, body) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, accept",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "content-length": Buffer.byteLength(json),
    });
    res.end(json);
  };

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, accept",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const versioned = /^\/v\d+(\/|$)/.test(path);
    if (!versioned) { send(res, 404, { error: "not_found" }); return; }
    if (rejectV1 || !path.startsWith("/v1/")) {
      send(res, 404, { error: "unknown_contract_version" });
      return;
    }
    if (req.method === "GET" && path === "/v1/info") {
      send(res, 200, { contract: CONTRACT, version: infoVersion, next_seq: nextSeq, extra: true });
      return;
    }
    if (req.method === "GET" && path === "/v1/events") {
      const since = parseSince(url.searchParams.get("since"));
      if (since === null || since < 0) { send(res, 400, { error: "bad_since" }); return; }
      const limitRaw = url.searchParams.get("limit");
      let limit = maxLimit;
      if (limitRaw !== null && limitRaw !== "") {
        if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) { send(res, 400, { error: "bad_request" }); return; }
        limit = Math.min(Number(limitRaw), maxLimit);
      }
      const rows = records.filter((r) => r.seq > since);
      const page = rows.slice(0, limit);
      send(res, 200, {
        contract: CONTRACT,
        version: 1,
        events: page.map((r) => ({ seq: r.seq, event: r.event })),
        next_seq: nextSeq,
        more: page.length < rows.length,
        extra: true,
      });
      return;
    }
    if (req.method === "POST" && path === "/v1/events") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(res, 400, { error: "bad_request" }); return; }
      if (typeof body !== "object" || body === null || Array.isArray(body) || !Array.isArray(body.events)) {
        send(res, 400, { error: "bad_request" });
        return;
      }
      const expected = body.expected_next_seq;
      if (typeof expected !== "number" || !Number.isInteger(expected)) {
        send(res, 400, { error: "bad_request" });
        return;
      }
      if (body.events.some((item) => !isNonEmptyId(item))) {
        send(res, 400, { error: "bad_request" });
        return;
      }
      if (expected !== nextSeq) {
        send(res, 409, { error: "seq_conflict", next_seq: nextSeq });
        return;
      }
      const stored = [];
      const skipped = [];
      for (const item of body.events) {
        const prev = byId.get(item.id);
        if (prev !== undefined) {
          skipped.push({ id: item.id, code: "duplicate_id", seq: prev });
          continue;
        }
        const seq = nextSeq++;
        records.push({ seq, id: item.id, event: item });
        byId.set(item.id, seq);
        stored.push({ id: item.id, seq });
      }
      send(res, 200, { stored, skipped, next_seq: nextSeq, extra: true });
      return;
    }
    send(res, 404, { error: "unknown_contract_version" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("endpoint failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}
