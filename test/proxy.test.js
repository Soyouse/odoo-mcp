// ═══════════════════════════════════════════════════════════════════════
// test/proxy.test.js — Tests d'intégration proxy.js (stdio, zéro dep).
// ═══════════════════════════════════════════════════════════════════════
//
// Lance le VRAI proxy.js branché sur test/fake-backend.js (override
// ODOO_BACKEND_CMD), parle MCP en JSON-RPC newline-delimited, et vérifie :
//   meta-tools exposés, formatage discover, mapping appel OK, validation
//   précoce (T-03), nom inconnu (suggestion), et surtout l'INVARIANT
//   never-crash (backend qui meurt en cours / au boot → erreur content,
//   proxy TOUJOURS vivant et répondant).
//
// Run : `node test/proxy.test.js` depuis la racine odoo-mcp/.

import { spawn } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, "..", "proxy.js");
const FAKE = path.join(__dirname, "fake-backend.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// Secrets factices (le proxy lit credentials.odoo ; le fake les ignore).
const SECRETS = path.join(os.tmpdir(), `odoo-proxy-test-secrets-${process.pid}.json`);
fs.writeFileSync(SECRETS, JSON.stringify({ credentials: { odoo: { url: "http://x", db: "x", login: "x", password: "x" } } }));

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
  kill() { try { this.rl.close(); } catch {} try { this.proc.kill(); } catch {} }
}

const text = (resp) => (resp?.result?.content || []).map((c) => c.text || "").join("");
const isErr = (resp) => resp?.result?.isError === true;

async function withProxy(scenario, fn, extraEnv = {}) {
  const c = new ProxyClient(scenario, extraEnv);
  try { await c.init(); await fn(c); }
  finally { c.kill(); }
}

async function main() {
  console.log("test/proxy.test.js\n");

  // ── Scénario OK : surface + formatage + appel + validation ──
  await withProxy("ok", async (c) => {
    const tools = await c.request("tools/list");
    const names = (tools.result?.tools || []).map((t) => t.name);
    ok("tools/list expose exactement [odoo_discover, odoo_call]", names.length === 2 && names.includes("odoo_discover") && names.includes("odoo_call"));

    const disc = await c.discover();
    ok("odoo_discover liste les outils backend (search_records)", text(disc).includes("search_records"));

    const r = await c.call("search_records", { model: "res.partner" });
    ok("odoo_call OK → content renvoyé (id 42 du fake)", text(r).includes("42") && !isErr(r));

    // T-03 : validation PRÉCOCE (aucun aller-retour backend)
    ok("odoo_call sans tool → erreur immédiate", isErr(await c.call("", {})) );
    ok("odoo_call args=string → erreur 'must be an object'", text(await c.call("search_records", "bad")).includes("must be an object"));

    // cache chaud après discover → nom inconnu rejeté + suggestion
    const unk = await c.call("search_record", { model: "x" }); // typo
    ok("odoo_call nom inconnu (cache chaud) → erreur + suggestion", isErr(unk) && text(unk).includes("search_records"));

    // MCP VOYANT bout-en-bout : une écriture déclenche la relecture search_records
    // (état réel, JSON récoltable) ET le scan mail (email parti pendant l'appel).
    const up = await c.call("update_record", { model: "account.move", record_id: 9, values: { ref: "x" } });
    ok("MCP voyant bout-en-bout : update → ÉTAT RÉEL relu et appendu", !isErr(up) && text(up).includes("ÉTAT RÉEL") && text(up).includes("payment_state") && text(up).includes('"id":9'));
    ok("scan mail bout-en-bout : email parti pendant l'appel → remonté", text(up).includes("MESSAGE(S) PARTI(S)") && text(up).includes("Fake Facture"));
  });

  // ── error_result : backend renvoie une erreur JSON-RPC → content erreur, proxy vivant ──
  await withProxy("error_result", async (c) => {
    const r = await c.call("search_records", { model: "x" });
    ok("backend error → content isError (jamais throw)", isErr(r) && text(r).toLowerCase().includes("error"));
    const r2 = await c.call("search_records", { model: "x" });
    ok("proxy répond encore après une erreur backend", r2 !== undefined);
  });

  // ── field_error : erreur d'OUTIL renvoyée en résultat isError (chemin RÉEL Odoo,
  //    PAS une erreur JSON-RPC). Prouve l'enrichissement T-04 bout-en-bout —
  //    le bug qui rendait l'enrichissement MORT en prod (callTool résolvait sans throw). ──
  await withProxy("field_error", async (c) => {
    const r = await c.call("search_records", { model: "res.partner", fields: ["naem"] });
    ok("Invalid field (isError content) → enrichi avec les champs valides", isErr(r) && text(r).includes("Champs valides") && text(r).includes("name"));
    ok("enrichissement → suggestion 'Probablement voulu' (naem≈name)", text(r).includes("name"));
    // sans model dans args → pas d'enrichissement possible, message d'origine + isError propagé
    const r2 = await c.call("search_records", {});
    ok("isError d'outil SANS model → propagé tel quel (pas de crash, isError gardé)", isErr(r2) && text(r2).includes("Invalid field"));
  });

  // ── crash_on_call : backend meurt en cours d'appel → erreur content, proxy survit + respawn ──
  await withProxy("crash_on_call", async (c) => {
    const r = await c.call("search_records", { model: "x" });
    ok("backend mort en cours d'appel → content erreur (proxy non crashé)", isErr(r));
    const r2 = await c.call("search_records", { model: "x" });
    ok("proxy toujours vivant après mort backend (respawn tenté)", isErr(r2));
  });

  // ── init_fail : backend mort au boot → erreur explicite, proxy vivant ──
  await withProxy("init_fail", async (c) => {
    const d = await c.discover();
    ok("backend mort au boot → odoo_discover renvoie une erreur (pas de freeze)", isErr(d));
    const r = await c.call("search_records", { model: "x" });
    ok("backend mort au boot → odoo_call renvoie une erreur (proxy vivant)", isErr(r));
  });

  // ── creds par ENV : le fichier secrets n'est JAMAIS lu (portable) ──
  await withProxy("ok", async (c) => {
    const d = await c.discover();
    ok("creds ODOO_URL/DB/USER/PASSWORD en env → proxy opérationnel SANS fichier secrets", !isErr(d) && text(d).includes("search_records"));
  }, {
    ODOO_SECRETS_PATH: path.join(__dirname, "no-such-secrets.json"),
    ODOO_URL: "http://env-creds", ODOO_DB: "d", ODOO_USER: "u", ODOO_PASSWORD: "p",
  });

  try { fs.unlinkSync(SECRETS); } catch {}
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL test harness:", e); process.exit(1); });
