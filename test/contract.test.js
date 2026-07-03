// ═══════════════════════════════════════════════════════════════════════
// test/contract.test.js — Tests de CONTRAT contre un VRAI Odoo (éphémère).
// ═══════════════════════════════════════════════════════════════════════
//
// Ne teste PAS notre logique (couverte par les 8 suites, fake backend) mais
// l'HYPOTHÈSE que le fake incarne : le vrai Odoo + le vrai backend pip se
// comportent comme on le prétend. Champs stables présents, formats de
// réponse, resource fields lisible, scan mail opérant. Si Odoo N+1 renomme
// un champ, C'EST ICI que ça rougit — aucune suite fake ne le verra.
//
// Prérequis : un Odoo réel joignable (db initialisée base+account+mail) —
// lancé par test/run-contract.sh (containers jetables) ou la CI.
// Env : CONTRACT_ODOO_URL / _DB / _USER / _PASSWORD (défauts localhost:8069,
// contract, admin, admin). HORS npm test (réseau) : `npm run test:contract`.
//
// ⚠️ JAMAIS pointer ce test sur un Odoo de production : il CRÉE des records.
import { spawn } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, "..", "proxy.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// Mini-client MCP stdio (même protocole que test/proxy.test.js, timeouts
// rallongés : un vrai Odoo répond en secondes, pas en millisecondes).
class ProxyClient {
  constructor() {
    this.proc = spawn("node", [PROXY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ODOO_URL: process.env.CONTRACT_ODOO_URL || "http://localhost:8069",
        ODOO_DB: process.env.CONTRACT_ODOO_DB || "contract",
        ODOO_USER: process.env.CONTRACT_ODOO_USER || "admin",
        ODOO_PASSWORD: process.env.CONTRACT_ODOO_PASSWORD || "admin",
        // Canary neutralisé (jamais de ping réel depuis un test).
        ODOO_CANARY_ENV: path.join(__dirname, "no-such-canary.env"),
      },
    });
    this.id = 0;
    this.pending = new Map();
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (l) => {
      try {
        const m = JSON.parse(l);
        if (m.id != null && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          p.resolve(m.result || m.error);
        }
      } catch {}
    });
    this.proc.stderr.on("data", () => {});
  }
  req(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, timeoutMs);
    });
  }
  async init() {
    await this.req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contract", version: "1.0.0" } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  call(tool, args) { return this.req("tools/call", { name: "odoo_call", arguments: { tool, args } }); }
  discover() { return this.req("tools/call", { name: "odoo_discover", arguments: {} }); }
  kill() { try { this.proc.kill(); } catch {} }
}

const text = (r) => (r?.content || []).map((c) => c.text || "").join("");
const isErr = (r) => r?.isError === true;

async function main() {
  console.log(`test/contract.test.js — vrai Odoo ${process.env.CONTRACT_ODOO_URL || "http://localhost:8069"}\n`);
  const c = new ProxyClient();
  await c.init();

  try {
    // 1. Surface réelle : les outils du backend existent, YOLO expose call_model_method.
    const d = await c.discover();
    ok("contrat surface : search_records exposé par le vrai backend", !isErr(d) && text(d).includes("search_records"));
    ok("contrat YOLO : call_model_method enregistré (double opt-in réel)", text(d).includes("call_model_method"));

    // 2. Contrat du hook provenance : les réponses contiennent bien `"id": N`.
    const s = await c.call("search_records", { model: "res.partner", fields: ["id", "name"], limit: 3 });
    ok("contrat récolte : search res.partner renvoie du JSON avec \"id\": N", !isErr(s) && /"id"\s*:\s*\d+/.test(text(s)));

    // 3. Contrat voyant + capability : create → relecture ÉTAT RÉEL avec les
    //    champs stables res.partner INTERSECTÉS contre les VRAIES métadonnées.
    const created = await c.call("create_record", { model: "res.partner", values: { name: "Contract Probe", email: "probe@example.com", city: "Testville" } });
    const cid = (text(created).match(/"id"\s*:\s*(\d+)/) || [])[1];
    ok("contrat voyant : create → ÉTAT RÉEL relu en base", !isErr(created) && text(created).includes("ÉTAT RÉEL") && !!cid);
    ok("contrat capability : champs stables res.partner lisibles sur ce serveur", text(created).includes("display_name") && text(created).includes("Contract Probe"));
    ok("contrat scan mail : verdict emails rendu (certitude ou 📧)", text(created).includes("Aucun destinataire notifié") || text(created).includes("PARTI(S)"));

    // 4. Contrat update : la relecture reflète la VRAIE base après écriture.
    const upd = await c.call("update_record", { model: "res.partner", record_id: Number(cid), values: { city: "Readbackville" } });
    ok("contrat update : relecture montre la nouvelle valeur", !isErr(upd) && text(upd).includes("Readbackville"));

    // 5. LE contrat de la garde anti-doublon : les champs décisifs existent
    //    sur account.move dans CETTE version d'Odoo. Un renommage majeur
    //    rougit ICI (search avec un champ inexistant = Invalid field).
    const g = await c.call("search_records", { model: "account.move", fields: ["id", "state", "payment_state", "is_move_sent"], limit: 1 });
    ok("contrat garde : state/payment_state/is_move_sent existent sur account.move", !isErr(g));

    // 6. Contrat resource fields : le format texte de odoo://model/fields
    //    est toujours parsable (enrichissement « Invalid field »).
    const bad = await c.call("search_records", { model: "res.partner", fields: ["naem"], limit: 1 });
    ok("contrat enrichissement : Invalid field réel → champs valides listés", isErr(bad) && text(bad).includes("Champs valides") && text(bad).includes("name"));
  } finally {
    c.kill();
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
