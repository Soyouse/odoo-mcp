// ═══════════════════════════════════════════════════════════════════════
// Tests lib/validate.js — runner vitest (mutation Stryker perTest).
// ⚠️ perTest : TOUT appel au code muté DOIT vivre DANS le callback d'un `it()`
//    (une const évaluée au chargement = mutant statique → faux survivant).
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { validateCall, suggest } from "./validate.js";

const KNOWN = ["search_records", "get_record", "create_record", "update_record", "delete_record", "execute_method", "list_models"];

describe("validateCall — tool manquant / mauvais type → erreur immédiate", () => {
  it("tool undefined → error", () => expect(validateCall(undefined, {}, KNOWN)).toBeTruthy());
  it("tool '' (vide) → error", () => expect(validateCall("", {}, KNOWN)).toBeTruthy());
  it("tool '   ' (espaces) → error", () => expect(validateCall("   ", {}, KNOWN)).toBeTruthy());
  it("tool number → error", () => expect(validateCall(42, {}, KNOWN)).toBeTruthy());
  it("tool '\\t\\n ' (whitespace) → erreur", () => expect(validateCall("\t\n ", {}, KNOWN)).toBeTruthy());
});

describe("validateCall — args mauvais type → erreur immédiate explicite", () => {
  it("args string → error", () => expect(validateCall("search_records", "model=x", KNOWN)).toBeTruthy());
  it("args array → error (mentionne 'array')", () => {
    expect(validateCall("search_records", [1, 2], KNOWN).error).toContain("array");
  });
  it("args null explicite → error", () => expect(validateCall("search_records", null, KNOWN)).toBeTruthy());
  it("args undefined → OK (toléré, proxy met {})", () => {
    expect(validateCall("search_records", undefined, KNOWN)).toBe(null);
  });
  it("args objet valide → OK", () => {
    expect(validateCall("search_records", { model: "res.partner" }, KNOWN)).toBe(null);
  });
});

describe("validateCall — nom d'outil inexistant (cache chaud) → error + suggestion", () => {
  it("tool typo 'search_record' → error", () => {
    expect(validateCall("search_record", { model: "x" }, KNOWN)).toBeTruthy(); // typo : manque le 's'
  });
  it("tool typo → suggère 'search_records'", () => {
    expect(validateCall("search_record", { model: "x" }, KNOWN).error).toContain("search_records");
  });
  it("tool inexistant sans match → error générique discover", () => {
    expect(validateCall("zzz_unknown", {}, KNOWN).error).toContain("odoo_discover");
  });
  it("suggestion multi → séparateur ', '", () => {
    expect(validateCall("record", {}, KNOWN).error).toContain(", ");
  });
});

describe("validateCall — cache FROID (knownToolNames absent) → nom NON bloqué", () => {
  it("cache absent → nom non validé (fail-open existence)", () => {
    expect(validateCall("nimporte_quoi", {}, null)).toBe(null);
  });
  it("cache absent → forme TOUJOURS validée (args string → error)", () => {
    expect(validateCall("x", "bad", null)).toBeTruthy();
  });
  it("validateCall cache=[] → nom non validé (null)", () => {
    expect(validateCall("nimporte_quoi", {}, [])).toBe(null);
  });
});

describe("validateCall — tool valide connu → OK", () => {
  it("tool connu + args objet → OK", () => {
    expect(validateCall("execute_method", { model: "sale.order", method: "write", args: [[1], {}] }, KNOWN)).toBe(null);
  });
});

describe("suggest()", () => {
  it("suggest('record', KNOWN) → trouve les *_record(s)", () => {
    expect(suggest("record", KNOWN).length).toBeGreaterThanOrEqual(2);
  });
  it("suggest sans cache → []", () => expect(suggest("x", null)).toHaveLength(0));
  it("suggest('x', []) → []", () => expect(suggest("x", [])).toHaveLength(0));
  it("suggest cap à 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => `tool_x${i}`);
    expect(suggest("tool_x", many)).toHaveLength(5);
  });
  it("suggest insensible à la casse", () => {
    expect(suggest("SEARCH", ["search_records"])).toContain("search_records");
  });
});

// ── messages : contenu vérifié (tue les mutants de string literal) ──
describe("validateCall — contenu des messages", () => {
  it("erreur tool mentionne 'tool' + 'required'", () => {
    const msg = validateCall("", {}, KNOWN).error;
    expect(msg).toMatch(/tool/i);
    expect(msg).toMatch(/required/i);
  });
  it("erreur args number mentionne 'object' + 'number'", () => {
    const msg = validateCall("search_records", 5, KNOWN).error;
    expect(msg).toContain("object");
    expect(msg).toContain("number");
  });
  it("erreur unknown mentionne le nom fautif", () => {
    expect(validateCall("zzz_nope", {}, KNOWN).error).toContain("zzz_nope");
  });
});
