// ═══════════════════════════════════════════════════════════════════════
// Tests lib/fields.js — runner vitest (mutation Stryker perTest).
// ⚠️ perTest : TOUT appel au code muté DOIT vivre DANS le callback d'un `it()`.
//    Les fixtures sont des THUNKS (jamais des const évaluées au chargement),
//    sinon les mutants deviennent « statiques » et survivent à tort.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { parseInvalidField, extractFieldNames, closeFields, formatFieldHint } from "./fields.js";

describe("parseInvalidField — message réel mesuré 2026-06-10", () => {
  it("détecte le message réel backend", () => {
    expect(parseInvalidField("Error executing tool search_records: Connection error: Operation failed: Invalid field 'recurring_invoice' in request")).toBe("recurring_invoice");
  });
  it("détecte guillemets doubles", () => {
    expect(parseInvalidField('Invalid field "price_unit" in request')).toBe("price_unit");
  });
  it("champ pointé (relation)", () => {
    expect(parseInvalidField("Invalid field 'partner_id.zzz' in request")).toBe("partner_id.zzz");
  });
  it("message sans invalid field → null", () => expect(parseInvalidField("Some other error")).toBe(null));
  it("non-string → null", () => expect(parseInvalidField(undefined)).toBe(null));
  it("parseInvalidField sans quotes", () => {
    expect(parseInvalidField("Invalid field recurring_invoice in request")).toBe("recurring_invoice");
  });
});

describe("extractFieldNames — JSON (forme réelle fields_get via proxy)", () => {
  it("extrait depuis JSON.parse", () => {
    const json = JSON.stringify({ success: true, model: "product.template", result: { name: { type: "char" }, list_price: { type: "float" }, invoice_policy: { type: "selection" } } });
    const names = extractFieldNames(json);
    expect(names).toHaveLength(3);
    expect(names).toContain("list_price");
    expect(names).toContain("invoice_policy");
  });
  it("fallback regex sur JSON cassé", () => {
    // Fallback regex si JSON cassé/tronqué mais motif présent
    const names = extractFieldNames('...."name": { "type": "char" }, "email": { "type": "char" } ....');
    expect(names).toContain("name");
    expect(names).toContain("email");
  });
  it("texte vide → []", () => expect(extractFieldNames("")).toHaveLength(0));
  it("extractFieldNames(null) → []", () => expect(extractFieldNames(null)).toHaveLength(0));
  it("extractFieldNames(123) → []", () => expect(extractFieldNames(123)).toHaveLength(0));
  it("JSON sans result → []", () => expect(extractFieldNames('{"success":true}')).toHaveLength(0));
  it("JSON result=array → [] (pas Object.keys)", () => expect(extractFieldNames('{"result":[1,2]}')).toHaveLength(0));
  it("JSON result=null → []", () => expect(extractFieldNames('{"result":null}')).toHaveLength(0));
  it("JSON result=string → []", () => expect(extractFieldNames('{"result":"x"}')).toHaveLength(0));
  it("JSON 'null' (obj falsy) → []", () => expect(extractFieldNames("null")).toHaveLength(0));
});

describe("extractFieldNames — format RESOURCE Odoo (texte humain, MESURÉ live 0.6.0)", () => {
  // Reproduit fidèlement odoo://res.partner/fields : `nom:` col-0 + lignes
  // indentées, avec en-têtes de section qui NE DOIVENT PAS être captés.
  const resourceText = () =>
    "============================================================\n" +
    "Field Definitions: res.partner\nTotal fields: 3\n\n" +
    "CHAR Fields (3):\n------------------------------\n\n" +
    "name:\n  Label: Name\n  Required: True\n\n" +
    "email:\n  Label: Email\n  Required: False\n\n" +
    "phone:\n  Label: Phone\n  Required: False\n";

  it("resource texte → extrait name/email/phone", () => {
    const names = extractFieldNames(resourceText());
    expect(names).toContain("name");
    expect(names).toContain("email");
    expect(names).toContain("phone");
  });
  it("resource texte → EXCLUT l'en-tête de section 'CHAR Fields'", () => {
    const names = extractFieldNames(resourceText());
    expect(names.some((n) => /char/i.test(n))).toBe(false);
    expect(names).not.toContain("Field");
  });
  it("resource texte → EXCLUT 'Total' (a du contenu après ':')", () => {
    expect(extractFieldNames(resourceText())).not.toContain("Total");
  });
  it("resource texte → EXCLUT les lignes indentées (Label/Required)", () => {
    const names = extractFieldNames(resourceText());
    expect(names).not.toContain("Label");
    expect(names).not.toContain("Required");
  });
  it("resource texte → exactement 3 champs", () => {
    expect(extractFieldNames(resourceText())).toHaveLength(3);
  });
  // Le format texte a priorité sur le fallback pretty-JSON (ordre des stratégies).
  it("ligne 'champ:' seule capturée", () => {
    expect(extractFieldNames("active:\nx:\n")).toHaveLength(2);
  });
});

describe("closeFields — suggestions par token", () => {
  const names = () => ["name", "list_price", "invoice_policy", "invoice_ids", "subscribable", "type"];

  it("recurring_invoice → suggère les invoice_*", () => {
    const near = closeFields("recurring_invoice", names());
    expect(near).toContain("invoice_policy");
    expect(near).toContain("invoice_ids");
  });
  it("ne suggère pas un champ sans rapport", () => {
    expect(closeFields("recurring_invoice", names())).not.toContain("type");
  });
  it("token court (<3) ignoré → pas de bruit", () => {
    expect(closeFields("id_x", ["description"])).not.toContain("description");
  });
  it("closeFields(_, null) → []", () => expect(closeFields("x", null)).toHaveLength(0));
  it("closeFields(_, 'str') → []", () => expect(closeFields("x", "str")).toHaveLength(0));
  it("closeFields(_, []) → []", () => expect(closeFields("x", [])).toHaveLength(0));
  it("closeFields superstring (ln⊃low)", () => {
    expect(closeFields("inv", ["invoice_id", "name"])).toContain("invoice_id");
  });
  it("closeFields substring (low⊃ln)", () => {
    expect(closeFields("invoice_policy", ["invoice", "zzz"])).toContain("invoice");
  });
  it("closeFields token len 3 ('tax') matche", () => {
    expect(closeFields("tax_zzz", ["tax_string", "other"])).toContain("tax_string");
  });
  it("closeFields token len 2 ('ab') ignoré", () => {
    expect(closeFields("ab_zzz", ["abc_def"])).not.toContain("abc_def");
  });
  it("closeFields cap à 10", () => {
    const many = Array.from({ length: 15 }, (_, i) => `invoice_${i}`);
    expect(closeFields("invoice", many)).toHaveLength(10);
  });
  it("closeFields badField MAJUSCULE matche", () => {
    expect(closeFields("INVOICE_X", ["invoice_policy"])).toContain("invoice_policy");
  });
  it("closeFields nom MAJUSCULE matche", () => {
    expect(closeFields("invoice", ["INVOICE_POLICY"])).toContain("INVOICE_POLICY");
  });
  it("closeFields direction low⊃ln seule", () => {
    // tue le mutant || → &&
    expect(closeFields("invoice_policy_x", ["inv"])).toContain("inv");
  });
});

describe("formatFieldHint — message final", () => {
  const names = () => ["name", "list_price", "invoice_policy"];

  it("hint mentionne le modèle + champ fautif", () => {
    const hint = formatFieldHint("product.template", "recurring_invoice", names());
    expect(hint).toContain("product.template");
    expect(hint).toContain("recurring_invoice");
  });
  it("hint liste les champs valides", () => {
    const hint = formatFieldHint("product.template", "recurring_invoice", names());
    expect(hint).toContain("list_price");
    expect(hint).toContain("Champs valides (3)");
  });
  it("hint propose la suggestion proche", () => {
    const hint = formatFieldHint("product.template", "recurring_invoice", names());
    expect(hint).toContain("Probablement voulu");
    expect(hint).toContain("invoice_policy");
  });
  it("aucun champ connu → null (on garde l'erreur d'origine)", () => {
    expect(formatFieldHint("m", "x", [])).toBe(null);
  });
  it("hint sans near = pas 'Probablement voulu' + liste", () => {
    const h = formatFieldHint("m", "zzzzz", ["alpha", "beta"]);
    expect(h).not.toContain("Probablement voulu");
    expect(h).toContain("Champs valides (2)");
  });
  it("hint liste TRIÉE", () => {
    const h = formatFieldHint("m", "x", ["zeta", "alpha", "mid"]);
    expect(h.indexOf("alpha")).toBeLessThan(h.indexOf("mid"));
    expect(h.indexOf("mid")).toBeLessThan(h.indexOf("zeta"));
  });
  it("hint sépare les champs par ', '", () => {
    expect(formatFieldHint("m", "x", ["a", "b"])).toContain("a, b");
  });
  it("near line jointe par ', '", () => {
    const h = formatFieldHint("m", "invoice", ["invoice_policy", "invoice_ids", "zzz"]);
    expect(h).toMatch(/Probablement voulu : invoice_\w+, invoice_\w+/);
  });
});
