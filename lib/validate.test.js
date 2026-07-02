// ═══════════════════════════════════════════════════════════════════════
// Tests lib/validate.js — Harness Node natif (zéro dep, ESM).
// Run : `node lib/validate.test.js` depuis la racine odoo-mcp/.
// Exit 0 si tous pass, 1 sinon.
// ═══════════════════════════════════════════════════════════════════════

import { validateCall, suggest } from "./validate.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
const KNOWN = ["search_records", "get_record", "create_record", "update_record", "delete_record", "execute_method", "list_models"];

console.log("lib/validate.test.js\n");

// ── tool manquant / mauvais type → erreur immédiate ──
ok("tool undefined → error", !!validateCall(undefined, {}, KNOWN));
ok("tool '' (vide) → error", !!validateCall("", {}, KNOWN));
ok("tool '   ' (espaces) → error", !!validateCall("   ", {}, KNOWN));
ok("tool number → error", !!validateCall(42, {}, KNOWN));

// ── args mauvais type → erreur immédiate explicite ──
ok("args string → error", !!validateCall("search_records", "model=x", KNOWN));
ok("args array → error (mentionne 'array')", (validateCall("search_records", [1, 2], KNOWN) || {}).error?.includes("array"));
ok("args null explicite → error", !!validateCall("search_records", null, KNOWN));
ok("args undefined → OK (toléré, proxy met {})", validateCall("search_records", undefined, KNOWN) === null);
ok("args objet valide → OK", validateCall("search_records", { model: "res.partner" }, KNOWN) === null);

// ── nom d'outil inexistant (cache chaud) → error + suggestion ──
{
  const r = validateCall("search_record", { model: "x" }, KNOWN); // typo : manque le 's'
  ok("tool typo 'search_record' → error", !!r);
  ok("tool typo → suggère 'search_records'", r.error.includes("search_records"));
}
ok("tool inexistant sans match → error générique discover", validateCall("zzz_unknown", {}, KNOWN).error.includes("odoo_discover"));

// ── cache FROID (knownToolNames absent) → on NE bloque PAS sur le nom ──
ok("cache absent → nom non validé (fail-open existence)", validateCall("nimporte_quoi", {}, null) === null);
ok("cache absent → forme TOUJOURS validée (args string → error)", !!validateCall("x", "bad", null));

// ── tool valide connu → OK ──
ok("tool connu + args objet → OK", validateCall("execute_method", { model: "sale.order", method: "write", args: [[1], {}] }, KNOWN) === null);

// ── suggest() unitaire ──
ok("suggest('record', KNOWN) → trouve les *_record(s)", suggest("record", KNOWN).length >= 2);
ok("suggest sans cache → []", suggest("x", null).length === 0);

// ── mutation-killers ciblés (Stryker) ──
// cache = [] (vide) → comme cache froid : nom NON validé
ok("validateCall cache=[] → nom non validé (null)", validateCall("nimporte_quoi", {}, []) === null);
// suggest : empty array → []
ok("suggest('x', []) → []", suggest("x", []).length === 0);
// suggest : cap à 5 (slice 0,5)
{ const many = Array.from({ length: 8 }, (_, i) => `tool_x${i}`); ok("suggest cap à 5", suggest("tool_x", many).length === 5); }
// suggest : insensible à la casse (toLowerCase des 2 côtés)
ok("suggest insensible à la casse", suggest("SEARCH", ["search_records"]).includes("search_records"));
// messages : contenu vérifié (tue les mutants de string literal)
ok("erreur tool mentionne 'tool' + 'required'", /tool/i.test(validateCall("", {}, KNOWN).error) && /required/i.test(validateCall("", {}, KNOWN).error));
ok("erreur args number mentionne 'object' + 'number'", validateCall("search_records", 5, KNOWN).error.includes("object") && validateCall("search_records", 5, KNOWN).error.includes("number"));
ok("erreur unknown mentionne le nom fautif", validateCall("zzz_nope", {}, KNOWN).error.includes("zzz_nope"));
// suggestion multi-hints → séparateur ', '
{ const r = validateCall("record", {}, KNOWN); ok("suggestion multi → séparateur ', '", r.error.includes(", ")); }
// tool whitespace-only → erreur (tue le mutant qui retire .trim())
ok("tool '\\t\\n ' (whitespace) → erreur", !!validateCall("\t\n ", {}, KNOWN));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
