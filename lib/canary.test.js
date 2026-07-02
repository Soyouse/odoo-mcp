// Tests lib/canary.js — tuyau I/O du canary NTFY, AUCUN réseau ni fichier réel
// (read/fetch injectés). Prouve : ping tenté avec la bonne requête, fail-silent
// total (fichier illisible, conf incomplète, réseau mort), jamais de rejet non géré.
import { fireCanary } from "./canary.js";
import { parseEnvText, canaryRequest } from "./readback.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const PURE = { parseEnvText, canaryRequest };
const ENV = "NTFY_URL=https://ntfy.example.com\nNTFY_TOPIC=acme-alerts\nNTFY_USER=admin\nNTFY_PASS=pw\n";

async function main() {
  console.log("lib/canary.test.js\n");

  {
    // Chemin nominal : env lu, requête construite, fetch appelé — sans attendre.
    const sent = [];
    const r = fireCanary(
      { ...PURE, envPath: "/fake.env", readFileSync: () => ENV, fetchImpl: (url, opts) => { sent.push({ url, opts }); return Promise.resolve({ ok: true }); } },
      "Garde Odoo MCP declenchee", "🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ",
    );
    ok("nominal: ping tenté → true", r === true);
    ok("nominal: POST vers NTFY_URL/topic", sent.length === 1 && sent[0].url === "https://ntfy.example.com/acme-alerts" && sent[0].opts.method === "POST");
    ok("nominal: titre + corps transmis", sent[0].opts.headers.Title === "Garde Odoo MCP declenchee" && sent[0].opts.body.includes("ANTI-DOUBLON"));
  }
  {
    // Fichier secrets illisible → false, AUCUN fetch, aucun throw.
    let fetched = false;
    const r = fireCanary({ ...PURE, envPath: "/fake.env", readFileSync: () => { throw new Error("ENOENT"); }, fetchImpl: () => { fetched = true; } }, "T", "m");
    ok("secrets illisibles → false, zéro fetch, zéro throw", r === false && fetched === false);
  }
  {
    // Conf incomplète (pas de topic) → false, AUCUN fetch.
    let fetched = false;
    const r = fireCanary({ ...PURE, envPath: "/fake.env", readFileSync: () => "NTFY_URL=https://x\n", fetchImpl: () => { fetched = true; } }, "T", "m");
    ok("conf incomplète → false, zéro fetch", r === false && fetched === false);
  }
  {
    // Réseau mort (fetch rejette) → true (tenté) et le rejet est ABSORBÉ
    // (un unhandledRejection ferait échouer ce process de test).
    let rejected = false;
    process.once("unhandledRejection", () => { rejected = true; });
    const r = fireCanary({ ...PURE, envPath: "/fake.env", readFileSync: () => ENV, fetchImpl: () => Promise.reject(new Error("réseau mort")) }, "T", "m");
    await new Promise((res) => setTimeout(res, 20));
    ok("fetch rejeté → true (tenté) + rejet absorbé", r === true && rejected === false);
  }
  {
    // fetch qui THROW en synchrone (ex. header invalide) → catché, false.
    const r = fireCanary({ ...PURE, envPath: "/fake.env", readFileSync: () => ENV, fetchImpl: () => { throw new Error("bad header"); } }, "T", "m");
    ok("fetch throw synchrone → false, zéro throw", r === false);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
