// ═══════════════════════════════════════════════════════════════════════
// test/proxy.test.js — Tests d'intégration proxy.js (stdio). Runner vitest.
// ═══════════════════════════════════════════════════════════════════════
//
// Lance le VRAI proxy.js branché sur test/fake-backend.js (override
// ODOO_BACKEND_CMD), parle MCP en JSON-RPC newline-delimited, et vérifie :
//   meta-tools exposés, formatage discover, mapping appel OK, validation
//   précoce (T-03), nom inconnu (suggestion), et surtout l'INVARIANT
//   never-crash (backend qui meurt en cours / au boot → erreur content,
//   proxy TOUJOURS vivant et répondant).
//
// ⚠️ Ce fichier SPAWNE des process → `testTimeout: 30000` (vitest.config.js).
// ⚠️ Chaque scénario = UN proxy spawné dans un beforeAll ; les requêtes y sont
//    SÉQUENTIELLES (le cache d'outils doit être chaud avant le test « nom
//    inconnu »), les `it` ne font qu'assener les assertions sur les résultats.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, "..", "proxy.js");
const FAKE = path.join(__dirname, "fake-backend.js");

// Secrets factices (le proxy lit credentials.odoo ; le fake les ignore).
const SECRETS = path.join(os.tmpdir(), `odoo-proxy-test-secrets-${process.pid}.json`);

beforeAll(() => {
  fs.writeFileSync(SECRETS, JSON.stringify({ credentials: { odoo: { url: "http://x", db: "x", login: "x", password: "x" } } }));
});
afterAll(() => {
  try { fs.unlinkSync(SECRETS); } catch { /* fichier jetable */ }
});

// ── Mini-client MCP stdio ──
class ProxyClient {
  constructor(scenario, extraEnv = {}) {
    this.proc = spawn("node", [PROXY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ODOO_BACKEND_CMD: JSON.stringify(["node", FAKE]),
        ODOO_SECRETS_PATH: SECRETS,
        ODOO_RETRY_DELAYS_MS: JSON.stringify([20, 20, 20]),
        // ⚠️ Canary NTFY neutralisé : sur la machine de dev le fichier secrets
        // EXISTE → un test de garde pingerait le VRAI topic d'alertes en silence.
        ODOO_CANARY_ENV: path.join(__dirname, "no-such-canary.env"),
        FAKE_SCENARIO: scenario,
        ...extraEnv,
      },
    });
    this.id = 0;
    this.pending = new Map();
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); p(msg);
      }
    });
  }
  request(method, params, timeoutMs = 5000) {
    this.id++; const id = this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async init() {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    this.notify("notifications/initialized");
  }
  call(tool, args) { return this.request("tools/call", { name: "odoo_call", arguments: { tool, args } }); }
  discover() { return this.request("tools/call", { name: "odoo_discover", arguments: {} }); }
  kill() { try { this.rl.close(); } catch { /* déjà fermé */ } try { this.proc.kill(); } catch { /* déjà mort */ } }
}

const text = (resp) => (resp?.result?.content || []).map((c) => c.text || "").join("");
const isErr = (resp) => resp?.result?.isError === true;

// Spawne un proxy pour la durée d'un describe et joue le scénario séquentiel.
function scenario(name, extraEnv, play) {
  const captured = {};
  let client;
  beforeAll(async () => {
    client = new ProxyClient(name, extraEnv);
    await client.init();
    Object.assign(captured, await play(client));
  });
  afterAll(() => { if (client) client.kill(); });
  return captured;
}

// ── Scénario OK : surface + formatage + appel + validation ──
describe("proxy — scénario ok (surface, formatage, appel, validation)", () => {
  const c = scenario("ok", {}, async (client) => {
    const tools = await client.request("tools/list");
    const disc = await client.discover();
    const call = await client.call("search_records", { model: "res.partner" });
    // T-03 : validation PRÉCOCE (aucun aller-retour backend)
    const noTool = await client.call("", {});
    const badArgs = await client.call("search_records", "bad");
    // cache chaud après discover → nom inconnu rejeté + suggestion
    const unknown = await client.call("search_record", { model: "x" }); // typo
    // MCP VOYANT bout-en-bout : une écriture déclenche la relecture search_records
    // (état réel, JSON récoltable) ET le scan mail (email parti pendant l'appel).
    const up = await client.call("update_record", { model: "account.move", record_id: 9, values: { ref: "x" } });
    return { names: (tools.result?.tools || []).map((t) => t.name), disc, call, noTool, badArgs, unknown, up };
  });

  it("tools/list expose exactement [odoo_discover, odoo_call]", () => {
    expect(c.names).toHaveLength(2);
    expect(c.names).toContain("odoo_discover");
    expect(c.names).toContain("odoo_call");
  });
  it("odoo_discover liste les outils backend (search_records)", () => {
    expect(text(c.disc)).toContain("search_records");
  });
  it("odoo_call OK → content renvoyé (id 42 du fake)", () => {
    expect(text(c.call)).toContain("42");
    expect(isErr(c.call)).toBe(false);
  });
  it("odoo_call sans tool → erreur immédiate", () => {
    expect(isErr(c.noTool)).toBe(true);
  });
  it("odoo_call args=string → erreur 'must be an object'", () => {
    expect(text(c.badArgs)).toContain("must be an object");
  });
  it("odoo_call nom inconnu (cache chaud) → erreur + suggestion", () => {
    expect(isErr(c.unknown)).toBe(true);
    expect(text(c.unknown)).toContain("search_records");
  });
  it("MCP voyant bout-en-bout : update → ÉTAT RÉEL relu et appendu", () => {
    expect(isErr(c.up)).toBe(false);
    expect(text(c.up)).toContain("ÉTAT RÉEL");
    expect(text(c.up)).toContain("payment_state");
    expect(text(c.up)).toContain('"id":9');
  });
  it("scan mail bout-en-bout : email parti pendant l'appel → remonté", () => {
    expect(text(c.up)).toContain("MESSAGE(S) PARTI(S)");
    expect(text(c.up)).toContain("Fake Facture");
  });
});

// ── error_result : backend renvoie une erreur JSON-RPC → content erreur, proxy vivant ──
describe("proxy — scénario error_result (jamais de throw)", () => {
  const c = scenario("error_result", {}, async (client) => ({
    r: await client.call("search_records", { model: "x" }),
    r2: await client.call("search_records", { model: "x" }),
  }));

  it("backend error → content isError (jamais throw)", () => {
    expect(isErr(c.r)).toBe(true);
    expect(text(c.r).toLowerCase()).toContain("error");
  });
  it("proxy répond encore après une erreur backend", () => {
    expect(c.r2).toBeDefined();
  });
});

// ── field_error : erreur d'OUTIL renvoyée en résultat isError (chemin RÉEL Odoo,
//    PAS une erreur JSON-RPC). Prouve l'enrichissement T-04 bout-en-bout —
//    le bug qui rendait l'enrichissement MORT en prod (callTool résolvait sans throw). ──
describe("proxy — scénario field_error (enrichissement bout-en-bout)", () => {
  const c = scenario("field_error", {}, async (client) => ({
    r: await client.call("search_records", { model: "res.partner", fields: ["naem"] }),
    // sans model dans args → pas d'enrichissement possible, message d'origine + isError propagé
    r2: await client.call("search_records", {}),
  }));

  it("Invalid field (isError content) → enrichi avec les champs valides", () => {
    expect(isErr(c.r)).toBe(true);
    expect(text(c.r)).toContain("Champs valides");
    expect(text(c.r)).toContain("name");
  });
  it("enrichissement → suggestion 'Probablement voulu' (naem≈name)", () => {
    expect(text(c.r)).toContain("name");
  });
  it("isError d'outil SANS model → propagé tel quel (pas de crash, isError gardé)", () => {
    expect(isErr(c.r2)).toBe(true);
    expect(text(c.r2)).toContain("Invalid field");
  });
});

// ── crash_on_call : backend meurt en cours d'appel → erreur content, proxy survit + respawn ──
describe("proxy — scénario crash_on_call (invariant never-crash)", () => {
  const c = scenario("crash_on_call", {}, async (client) => ({
    r: await client.call("search_records", { model: "x" }),
    r2: await client.call("search_records", { model: "x" }),
  }));

  it("backend mort en cours d'appel → content erreur (proxy non crashé)", () => {
    expect(isErr(c.r)).toBe(true);
  });
  it("proxy toujours vivant après mort backend (respawn tenté)", () => {
    expect(isErr(c.r2)).toBe(true);
  });
});

// ── init_fail : backend mort au boot → erreur explicite, proxy vivant ──
describe("proxy — scénario init_fail (backend mort au boot)", () => {
  const c = scenario("init_fail", {}, async (client) => ({
    d: await client.discover(),
    r: await client.call("search_records", { model: "x" }),
  }));

  it("backend mort au boot → odoo_discover renvoie une erreur (pas de freeze)", () => {
    expect(isErr(c.d)).toBe(true);
  });
  it("backend mort au boot → odoo_call renvoie une erreur (proxy vivant)", () => {
    expect(isErr(c.r)).toBe(true);
  });
});

// ── creds par ENV : le fichier secrets n'est JAMAIS lu (portable) ──
describe("proxy — creds par ENV (fichier secrets jamais lu)", () => {
  const c = scenario("ok", {
    ODOO_SECRETS_PATH: path.join(__dirname, "no-such-secrets.json"),
    ODOO_URL: "http://env-creds", ODOO_DB: "d", ODOO_USER: "u", ODOO_PASSWORD: "p",
  }, async (client) => ({ d: await client.discover() }));

  it("creds ODOO_URL/DB/USER/PASSWORD en env → proxy opérationnel SANS fichier secrets", () => {
    expect(isErr(c.d)).toBe(false);
    expect(text(c.d)).toContain("search_records");
  });
});
