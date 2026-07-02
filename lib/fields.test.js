// ═══════════════════════════════════════════════════════════════════════
// Tests lib/fields.js — Harness Node natif (zéro dep, ESM).
// Run : `node lib/fields.test.js` depuis la racine odoo-mcp/.
// ═══════════════════════════════════════════════════════════════════════

import { parseInvalidField, extractFieldNames, closeFields, formatFieldHint } from "./fields.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("lib/fields.test.js\n");

// ── parseInvalidField — message réel mesuré 2026-06-10 ──
ok("détecte le message réel backend", parseInvalidField("Error executing tool search_records: Connection error: Operation failed: Invalid field 'recurring_invoice' in request") === "recurring_invoice");
ok("détecte guillemets doubles", parseInvalidField('Invalid field "price_unit" in request') === "price_unit");
ok("champ pointé (relation)", parseInvalidField("Invalid field 'partner_id.zzz' in request") === "partner_id.zzz");
ok("message sans invalid field → null", parseInvalidField("Some other error") === null);
ok("non-string → null", parseInvalidField(undefined) === null);

// ── extractFieldNames — JSON propre (forme réelle fields_get via proxy) ──
{
  const json = JSON.stringify({ success: true, model: "product.template", result: { name: { type: "char" }, list_price: { type: "float" }, invoice_policy: { type: "selection" } } });
  const names = extractFieldNames(json);
  ok("extrait depuis JSON.parse", names.length === 3 && names.includes("list_price") && names.includes("invoice_policy"));
}
{
  // Fallback regex si JSON cassé/tronqué mais motif présent
  const broken = '...."name": { "type": "char" }, "email": { "type": "char" } ....';
  const names = extractFieldNames(broken);
  ok("fallback regex sur JSON cassé", names.includes("name") && names.includes("email"));
}
ok("texte vide → []", extractFieldNames("") .length === 0);

// ── extractFieldNames — format RESOURCE Odoo (texte humain, MESURÉ live 0.6.0) ──
{
  // Reproduit fidèlement odoo://res.partner/fields : `nom:` col-0 + lignes
  // indentées, avec en-têtes de section qui NE DOIVENT PAS être captés.
  const resourceText =
    "============================================================\n" +
    "Field Definitions: res.partner\nTotal fields: 3\n\n" +
    "CHAR Fields (3):\n------------------------------\n\n" +
    "name:\n  Label: Name\n  Required: True\n\n" +
    "email:\n  Label: Email\n  Required: False\n\n" +
    "phone:\n  Label: Phone\n  Required: False\n";
  const names = extractFieldNames(resourceText);
  ok("resource texte → extrait name/email/phone", names.includes("name") && names.includes("email") && names.includes("phone"));
  ok("resource texte → EXCLUT l'en-tête de section 'CHAR Fields'", !names.some((n) => /char/i.test(n)) && !names.includes("Field"));
  ok("resource texte → EXCLUT 'Total' (a du contenu après ':')", !names.includes("Total"));
  ok("resource texte → EXCLUT les lignes indentées (Label/Required)", !names.includes("Label") && !names.includes("Required"));
  ok("resource texte → exactement 3 champs", names.length === 3);
}
// Le format texte a priorité sur le fallback pretty-JSON (ordre des stratégies).
ok("ligne 'champ:' seule capturée", extractFieldNames("active:\nx:\n").length === 2);

// ── closeFields — suggestions par token ──
{
  const names = ["name", "list_price", "invoice_policy", "invoice_ids", "subscribable", "type"];
  const near = closeFields("recurring_invoice", names);
  ok("recurring_invoice → suggère les invoice_*", near.includes("invoice_policy") && near.includes("invoice_ids"));
  ok("ne suggère pas un champ sans rapport", !near.includes("type"));
}
ok("token court (<3) ignoré → pas de bruit", !closeFields("id_x", ["description"]).includes("description"));

// ── formatFieldHint — message final ──
{
  const names = ["name", "list_price", "invoice_policy"];
  const hint = formatFieldHint("product.template", "recurring_invoice", names);
  ok("hint mentionne le modèle + champ fautif", hint.includes("product.template") && hint.includes("recurring_invoice"));
  ok("hint liste les champs valides", hint.includes("list_price") && hint.includes("Champs valides (3)"));
  ok("hint propose la suggestion proche", hint.includes("Probablement voulu") && hint.includes("invoice_policy"));
}
ok("aucun champ connu → null (on garde l'erreur d'origine)", formatFieldHint("m", "x", []) === null);

// ── mutation-killers ciblés (Stryker) ──
// parseInvalidField : quotes optionnelles
ok("parseInvalidField sans quotes", parseInvalidField("Invalid field recurring_invoice in request") === "recurring_invoice");
// extractFieldNames : entrées non-string → []
ok("extractFieldNames(null) → []", extractFieldNames(null).length === 0);
ok("extractFieldNames(123) → []", extractFieldNames(123).length === 0);
// extractFieldNames : result absent/array/primitif/null → fallback (pas de "type" → [])
ok("JSON sans result → []", extractFieldNames('{"success":true}').length === 0);
ok("JSON result=array → [] (pas Object.keys)", extractFieldNames('{"result":[1,2]}').length === 0);
ok("JSON result=null → []", extractFieldNames('{"result":null}').length === 0);
ok("JSON result=string → []", extractFieldNames('{"result":"x"}').length === 0);
ok("JSON 'null' (obj falsy) → []", extractFieldNames('null').length === 0);
// closeFields : guards
ok("closeFields(_, null) → []", closeFields("x", null).length === 0);
ok("closeFields(_, 'str') → []", closeFields("x", "str").length === 0);
ok("closeFields(_, []) → []", closeFields("x", []).length === 0);
// closeFields : superstring (ln.includes(low)) — badField court inclus dans un nom
ok("closeFields superstring (ln⊃low)", closeFields("inv", ["invoice_id", "name"]).includes("invoice_id"));
// closeFields : substring (low.includes(ln)) — nom court inclus dans badField
ok("closeFields substring (low⊃ln)", closeFields("invoice_policy", ["invoice", "zzz"]).includes("invoice"));
// closeFields : token len EXACTEMENT 3 matche ; len 2 ignoré
ok("closeFields token len 3 ('tax') matche", closeFields("tax_zzz", ["tax_string", "other"]).includes("tax_string"));
ok("closeFields token len 2 ('ab') ignoré", !closeFields("ab_zzz", ["abc_def"]).includes("abc_def"));
// closeFields : cap à 10
{ const many = Array.from({ length: 15 }, (_, i) => `invoice_${i}`); ok("closeFields cap à 10", closeFields("invoice", many).length === 10); }
// formatFieldHint : sans suggestion proche → pas de 'Probablement voulu', mais liste présente
{ const h = formatFieldHint("m", "zzzzz", ["alpha", "beta"]); ok("hint sans near = pas 'Probablement voulu' + liste", !h.includes("Probablement voulu") && h.includes("Champs valides (2)")); }
// formatFieldHint : liste triée alphabétiquement
{ const h = formatFieldHint("m", "x", ["zeta", "alpha", "mid"]); ok("hint liste TRIÉE", h.indexOf("alpha") < h.indexOf("mid") && h.indexOf("mid") < h.indexOf("zeta")); }
// formatFieldHint : séparateur ', ' dans la liste
{ const h = formatFieldHint("m", "x", ["a", "b"]); ok("hint sépare les champs par ', '", h.includes("a, b")); }
// closeFields : casse (toLowerCase du badField ET des noms)
ok("closeFields badField MAJUSCULE matche", closeFields("INVOICE_X", ["invoice_policy"]).includes("invoice_policy"));
ok("closeFields nom MAJUSCULE matche", closeFields("invoice", ["INVOICE_POLICY"]).includes("INVOICE_POLICY"));
// closeFields : match par la SEULE direction low⊃ln (tue le mutant || → &&)
ok("closeFields direction low⊃ln seule", closeFields("invoice_policy_x", ["inv"]).includes("inv"));
// formatFieldHint : ligne 'Probablement voulu' joint par ', '
{ const h = formatFieldHint("m", "invoice", ["invoice_policy", "invoice_ids", "zzz"]); ok("near line jointe par ', '", /Probablement voulu : invoice_\w+, invoice_\w+/.test(h)); }

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
