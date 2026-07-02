// Tests lib/readback.js — logique PURE du « MCP voyant » + garde anti-doublon.
// Zéro I/O : on prouve les PLANS (quoi relire, quoi bloquer), pas l'exécution
// (couverte par handlers.test.js avec backend factice).
import {
  toIdArray, extractCommandIds, parseCreatedId, parseSearchRecords,
  readbackPlan, cascadePlan, sendGuardPlan, stableFieldsFor,
  formatReadback, formatGuardBlock, GUARD_FIELDS,
  MAIL_SCAN_TOOLS, mailSnapshotCall, mailScanCall, latestMessageId, formatMailReport,
  intersectFields, formatGuardIncapable, pitfallWarning,
  createGuardPlan, duplicateInvoices, formatCreateGuardBlock, CREATE_GUARD_FIELDS,
  parseEnvText, canaryRequest,
} from "./readback.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("lib/readback.test.js\n");

// ── toIdArray ──
ok("toIdArray: tableau d'ints", eq(toIdArray([1, 2, 3]), [1, 2, 3]));
ok("toIdArray: string JSON (forme backend)", eq(toIdArray("[9]"), [9]));
ok("toIdArray: mixte int+string → [] (pas un pur tableau d'ids)", eq(toIdArray([1, "a"]), []));
ok("toIdArray: objet/null/négatifs → []", eq(toIdArray({}), []) && eq(toIdArray(null), []) && eq(toIdArray([-1]), []));

// ── extractCommandIds (commandes ORM x2many) ──
ok("commands: (6,0,[ids])", eq(extractCommandIds([[6, 0, [9, 10]]]), [9, 10]));
ok("commands: (4,id) + id nu + doublon dédupliqué", eq(extractCommandIds([[4, 9], 9, [4, 11]]), [9, 11]));
ok("commands: non-tableau → []", eq(extractCommandIds("x"), []));

// ── parseCreatedId ──
ok("createdId: JSON {record:{id}}", parseCreatedId('{"success":true,"record":{"id":42,"display_name":"X"}}') === 42);
ok("createdId: fallback message 'with ID N'", parseCreatedId("Successfully created account.move record with ID 9") === 9);
ok("createdId: illisible → null", parseCreatedId("rien") === null && parseCreatedId(undefined) === null);

// ── parseSearchRecords ──
ok("searchRecords: {records:[...]}", eq(parseSearchRecords('{"records":[{"id":1}],"total":1}'), [{ id: 1 }]));
ok("searchRecords: JSON sans records / invalide → null", parseSearchRecords("{}") === null && parseSearchRecords("x") === null);

// ── readbackPlan ──
{
  const p = readbackPlan("update_record", { model: "account.move", record_id: 9 }, "");
  ok("plan update_record → ids=[record_id] + champs stables account.move",
    p && eq(p.ids, [9]) && p.fields.includes("is_move_sent") && p.fields.includes("payment_state"));
}
{
  const p = readbackPlan("create_record", { model: "x.inconnu", values: {} }, '{"record":{"id":7}}');
  ok("plan create_record → id parsé du résultat + fallback fields", p && eq(p.ids, [7]) && eq(p.fields, ["display_name", "write_date"]));
}
{
  const p = readbackPlan("call_model_method", { model: "sale.subscription", method: "generate_invoice", arguments: [[3]] }, "null");
  ok("plan call_model_method → ids=arguments[0] (le cas réel : retour null)", p && eq(p.ids, [3]) && p.fields.includes("invoice_ids"));
}
{
  const p = readbackPlan("call_model_method", { model: "account.move", method: "action_post", arguments: "[[9]]" }, "null");
  ok("plan call_model_method: arguments en string JSON", p && eq(p.ids, [9]));
}
ok("plan: outil lecture → null", readbackPlan("search_records", { model: "res.partner" }, "") === null);
ok("plan: delete_record → null (record mort)", readbackPlan("delete_record", { model: "res.partner", record_id: 1 }, "") === null);
ok("plan: sans model / sans ids → null",
  readbackPlan("update_record", { record_id: 1 }, "") === null &&
  readbackPlan("call_model_method", { model: "res.partner", arguments: [] }, "") === null);
{
  const p = readbackPlan("call_model_method", { model: "res.partner", arguments: [[...Array(20).keys()].map((i) => i + 1)] }, "");
  ok("plan: cap à 10 ids relus", p && p.ids.length === 10);
}

// ── cascadePlan (abo → factures) ──
{
  const c = cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [9, 12, 10] }]);
  ok("cascade abo → account.move, ids triés récents d'abord", c && c.model === "account.move" && eq(c.ids, [12, 10, 9]));
}
ok("cascade: autre modèle / sans factures → null",
  cascadePlan("account.move", [{ id: 9 }]) === null &&
  cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [] }]) === null);
{
  const c = cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [1, 2, 3, 4, 5, 6, 7] }]);
  ok("cascade: cap à 5 factures les plus récentes", c && eq(c.ids, [7, 6, 5, 4, 3]));
}

// ── sendGuardPlan (anti-doublon) ──
{
  const g = sendGuardPlan("call_model_method", { model: "account.move", method: "action_send_and_print", arguments: [[9]] });
  ok("garde: call_model_method account.move *send* → ids gardés", g && eq(g.ids, [9]));
}
{
  const g = sendGuardPlan("create_record", { model: "account.move.send", values: { move_ids: [[6, 0, [9]]] } });
  ok("garde: wizard account.move.send (create) → move_ids extraits", g && g.model === "account.move" && eq(g.ids, [9]));
}
ok("garde: méthodes non-send / autres modèles → null",
  sendGuardPlan("call_model_method", { model: "account.move", method: "action_post", arguments: [[9]] }) === null &&
  sendGuardPlan("call_model_method", { model: "res.partner", method: "send_thing", arguments: [[1]] }) === null &&
  sendGuardPlan("update_record", { model: "account.move", record_id: 9 }) === null);
ok("garde: send sans ids identifiables → null (le hook provenance couvre déjà)",
  sendGuardPlan("call_model_method", { model: "account.move", method: "send_and_print", arguments: [] }) === null);
ok("GUARD_FIELDS contient is_move_sent (le champ décisif)", GUARD_FIELDS.includes("is_move_sent"));

// ── formatage ──
{
  const t = formatReadback("account.move", [{ id: 9, name: "FAC/2026/00003", is_move_sent: true }], [9, 10]);
  ok("formatReadback: état réel + ids introuvables signalés",
    t.includes("ÉTAT RÉEL") && t.includes('"id":9') && t.includes('"is_move_sent":true') && t.includes("INTROUVABLES") && t.includes("#10"));
}
{
  const t = formatGuardBlock([{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid" }]);
  ok("formatGuardBlock: blocage explicite + issue force_resend",
    t.includes("GARDE ANTI-DOUBLON") && t.includes("FAC/2026/00003") && t.includes("force_resend"));
}
ok("stableFieldsFor: fallback modèles inconnus", eq(stableFieldsFor("x.y"), ["display_name", "write_date"]));

// ── ASSERTIONS EXACTES (anti-mutants : champs, formats, bornes) ──
ok("fields account.move EXACTS", eq(stableFieldsFor("account.move"), ["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"]));
ok("fields sale.subscription EXACTS", eq(stableFieldsFor("sale.subscription"), ["display_name", "invoice_ids"]));
ok("fields sale.order EXACTS", eq(stableFieldsFor("sale.order"), ["name", "state", "invoice_status", "amount_total"]));
ok("GUARD_FIELDS EXACTS", eq(GUARD_FIELDS, ["name", "state", "payment_state", "is_move_sent"]));
{
  const t = formatReadback("account.move", [{ id: 9, name: "F", is_move_sent: true }], [9]);
  ok("formatReadback EXACT (JSON récoltable par le hook provenance)",
    t === '═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\naccount.move {"id":9,"name":"F","is_move_sent":true}');
}
{
  const t = formatReadback("account.move", [{ id: 9, name: "F" }], [9, 10, 11]);
  ok("formatReadback EXACT (manquants listés)",
    t === '═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\naccount.move {"id":9,"name":"F"}\n⚠️ INTROUVABLES en base : #10, #11 (supprimés ou jamais créés)');
}
{
  const t = formatGuardBlock([{ id: 9, name: "N", state: "posted", payment_state: "not_paid" }]);
  ok("formatGuardBlock EXACT",
    t === "🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ — facture(s) DÉJÀ ENVOYÉE(S) au client :\n" +
      "account.move #9 N — is_move_sent: true · state: posted · payment_state: not_paid\n" +
      "Renvoyer = email en double chez le client (incident du 2026-07-01). Si le renvoi est VOULU et assumé, rappelle avec args.force_resend: true.");
}
{
  const p = readbackPlan("update_record", { model: "account.move", record_id: 9 }, "");
  ok("plan update EXACT (model+ids+fields)", eq(p, { model: "account.move", ids: [9], fields: ["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"] }));
}
ok("plan: model chaîne vide → null", readbackPlan("update_record", { model: "", record_id: 9 }, "") === null);
ok("plan: record_id 0 / négatif / float → null",
  readbackPlan("update_record", { model: "x", record_id: 0 }, "") === null &&
  readbackPlan("update_record", { model: "x", record_id: -3 }, "") === null &&
  readbackPlan("update_record", { model: "x", record_id: 1.5 }, "") === null);
ok("toIdArray: float / zéro → []", eq(toIdArray([1.5]), []) && eq(toIdArray([0]), []));
ok("commands: (5,x)/(3,x) IGNORÉS (seuls 4 et 6 portent des ids ajoutés)", eq(extractCommandIds([[5], [3, 9]]), []));
{
  const g = sendGuardPlan("call_model_method", { model: "account.move", method: "SEND_AND_PRINT", arguments: [[9]] });
  ok("garde: match send insensible à la casse", g && eq(g.ids, [9]));
}
ok("garde: modèle préfixé (x.account.move.send) → null (startsWith strict)",
  sendGuardPlan("create_record", { model: "x.account.move.send", values: { move_ids: [[6, 0, [9]]] } }) === null);
{
  const g = sendGuardPlan("call_model_method", { model: "account.move", method: "send_and_print", arguments: "[[7,8]]" });
  ok("garde: arguments en string JSON compris", g && eq(g.ids, [7, 8]));
}
ok("createdId: id 0 / record absent → null", parseCreatedId('{"record":{"id":0}}') === null && parseCreatedId('{"success":true}') === null);
{
  const c = cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [9] }, { id: 4, invoice_ids: [9, 11] }]);
  ok("cascade: multi-abos fusionnés + dédup + fields account.move EXACTS",
    c && eq(c.ids, [11, 9]) && eq(c.fields, ["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"]));
}

// Multi-éléments pour tuer les mutants de séparateurs (join sur 1 élément = indétectable).
{
  const t = formatReadback("res.partner", [{ id: 1, display_name: "A" }, { id: 2, display_name: "B" }], [1, 2]);
  ok("formatReadback EXACT multi-records (séparateur \\n)",
    t === '═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\nres.partner {"id":1,"display_name":"A"}\nres.partner {"id":2,"display_name":"B"}');
}
{
  const t = formatGuardBlock([
    { id: 9, name: "A", state: "posted", payment_state: "not_paid" },
    { id: 10, name: "B", state: "posted", payment_state: "paid" },
  ]);
  ok("formatGuardBlock EXACT multi-factures (séparateur \\n)",
    t === "🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ — facture(s) DÉJÀ ENVOYÉE(S) au client :\n" +
      "account.move #9 A — is_move_sent: true · state: posted · payment_state: not_paid\n" +
      "account.move #10 B — is_move_sent: true · state: posted · payment_state: paid\n" +
      "Renvoyer = email en double chez le client (incident du 2026-07-01). Si le renvoi est VOULU et assumé, rappelle avec args.force_resend: true.");
}
{
  const t = formatGuardBlock([{ id: 9, state: "posted", payment_state: "not_paid" }]);
  ok("formatGuardBlock: name absent → chaîne vide (pas 'undefined')", t.includes("account.move #9  — is_move_sent") && !t.includes("undefined"));
}

// ── Tueurs de mutants ciblés (bordures et chemins dégénérés) ──
ok("toIdArray: string JSON invalide → []", eq(toIdArray("{bad"), []));
ok("commands: id nu SEUL extrait", eq(extractCommandIds([7]), [7]));
ok("commands: 0 et négatif nus rejetés", eq(extractCommandIds([0, -2]), []));
ok("commands: (6,0,[...]) filtre 0/négatif/float", eq(extractCommandIds([[6, 0, [0, -1, 2.5, 9]]]), [9]));
ok("commands: (6,0,scalaire) → [] (pas de spread sauvage)", eq(extractCommandIds([[6, 0, 5]]), []));
ok("commands: (3,0,[ids]) IGNORÉ (3 ≠ ajout)", eq(extractCommandIds([[3, 0, [9]]]), []));
ok("createdId: multi-digits capturés (42, pas 4)", parseCreatedId("Successfully created record with ID 42") === 42);
ok("plan: callArgs undefined → null (pas de crash)", readbackPlan("update_record", undefined, "") === null);
ok("plan: create sans id parsable → null", readbackPlan("create_record", { model: "x" }, "aucun id") === null);
ok("plan: call_model_method arguments non-tableau → null", readbackPlan("call_model_method", { model: "x", arguments: { vals: 1 } }, "") === null);
ok("plan: outil lecture MÊME avec arguments[[ids]] → null", readbackPlan("get_record", { model: "x", arguments: [[1]] }, "") === null);
ok("cascade: records non-tableau → null (pas de crash)", cascadePlan("sale.subscription", "pas-un-tableau") === null);
ok("cascade: autre modèle MÊME avec invoice_ids → null", cascadePlan("account.move", [{ id: 1, invoice_ids: [9] }]) === null);

// ── Scan mail (emails partis pendant l'appel) ──
ok("MAIL_SCAN_TOOLS EXACT (les 4 outils d'écriture)",
  eq([...MAIL_SCAN_TOOLS].sort(), ["call_model_method", "create_record", "post_message", "update_record"]));
ok("mailSnapshotCall EXACT (dernier id, 1 record)",
  eq(mailSnapshotCall(), { model: "mail.message", domain: [], fields: ["id"], limit: 1, order: "id desc" }));
ok("mailScanCall EXACT (id > baseline + destinataires non vides)",
  eq(mailScanCall(100), {
    model: "mail.message",
    domain: [["id", ">", 100], ["partner_ids", "!=", false]],
    fields: ["message_type", "subject", "email_from", "partner_ids", "model", "res_id"],
    limit: 10,
    order: "id asc",
  }));
ok("latestMessageId: [{id:5}] → 5 · [] → 0 (base vide valide) · null/illisible → null",
  latestMessageId([{ id: 5 }]) === 5 && latestMessageId([]) === 0 &&
  latestMessageId(null) === null && latestMessageId([{ id: "x" }]) === null && latestMessageId([{}]) === null);
{
  const t = formatMailReport([
    { id: 101, subject: "Facture", partner_ids: [16] },
    { id: 102, subject: "Relance", partner_ids: [16] },
  ]);
  ok("formatMailReport EXACT multi-messages",
    t === "📧 2 MESSAGE(S) PARTI(S) VERS DES DESTINATAIRES PENDANT L'APPEL — en tenir compte AVANT tout renvoi :\n" +
      'mail.message {"id":101,"subject":"Facture","partner_ids":[16]}\n' +
      'mail.message {"id":102,"subject":"Relance","partner_ids":[16]}');
}
ok("formatMailReport: vide/illisible → certitude « aucun email »",
  formatMailReport([]) === "📧 Aucun destinataire notifié pendant l'appel (aucun email parti)." &&
  formatMailReport(null) === "📧 Aucun destinataire notifié pendant l'appel (aucun email parti).");
ok("fields res.partner EXACTS", eq(stableFieldsFor("res.partner"), ["display_name", "email", "phone", "city"]));

// ── Capability detection (souhaité ∩ réel) ──
ok("intersect: garde l'ordre des souhaités, omet les absents",
  eq(intersectFields(["a", "b", "c"], ["c", "a", "x"]), ["a", "c"]));
ok("intersect: liste réelle indisponible (null/vide) → souhaits INCHANGÉS (fail-safe)",
  eq(intersectFields(["a", "b"], null), ["a", "b"]) && eq(intersectFields(["a", "b"], []), ["a", "b"]));
ok("intersect: intersection vide → fallback display_name (jamais une liste vide)",
  eq(intersectFields(["x", "y"], ["a", "display_name"]), ["display_name"]) &&
  eq(intersectFields(["x"], ["a", "b"]), ["display_name"]));
ok("intersect: fallback garde write_date SI présent",
  eq(intersectFields(["x"], ["write_date", "a"]), ["display_name", "write_date"]));
{
  const t = formatGuardIncapable();
  ok("formatGuardIncapable: annonce l'incapacité + issue force_resend",
    t.includes("n'expose PAS") && t.includes("is_move_sent") && t.includes("force_resend"));
}

// ── Pièges connus (savoir métier dans le tuyau) ──
{
  const w = pitfallWarning("call_model_method", { model: "sale.subscription", method: "generate_invoice" });
  ok("piège: generate_invoice abo → warning invoicing_mode/doublon",
    typeof w === "string" && w.includes("PIÈGE CONNU") && w.includes("invoice_send") && w.includes("NE PAS renvoyer"));
  ok("piège: create_invoice abo matche aussi (/invoice/i)",
    pitfallWarning("call_model_method", { model: "sale.subscription", method: "create_invoice" }) !== null);
}
ok("piège: send_mail template → warning auto-delete + délivrabilité",
  String(pitfallWarning("call_model_method", { model: "mail.template", method: "send_mail" })).includes("AUTO-SUPPRIMÉ") &&
  pitfallWarning("call_model_method", { model: "mail.template", method: "SEND_MAIL" }) !== null &&
  pitfallWarning("call_model_method", { model: "mail.template", method: "send_mail_x" }) === null);
ok("piège: action_cancel devis → warning unlock/wizard",
  String(pitfallWarning("call_model_method", { model: "sale.order", method: "action_cancel" })).includes("action_unlock"));
// ── Garde anti-double-création ──
{
  const g = createGuardPlan("call_model_method", { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] });
  ok("création: generate_invoice → plan {sale.subscription, ids}", g && g.model === "sale.subscription" && eq(g.ids, [7]));
  ok("création: create_invoice matche, arguments string JSON compris",
    createGuardPlan("call_model_method", { model: "sale.subscription", method: "create_invoice", arguments: "[[7]]" }) !== null);
}
ok("création: méthodes de LECTURE (action_view_account_invoice_ids) → null",
  createGuardPlan("call_model_method", { model: "sale.subscription", method: "action_view_account_invoice_ids", arguments: [[7]] }) === null);
ok("création: autres modèles/outils/sans ids → null",
  createGuardPlan("call_model_method", { model: "account.move", method: "generate_invoice", arguments: [[9]] }) === null &&
  createGuardPlan("create_record", { model: "sale.subscription", method: "generate_invoice" }) === null &&
  createGuardPlan("call_model_method", { model: "sale.subscription", method: "generate_invoice", arguments: [] }) === null);
ok("CREATE_GUARD_FIELDS EXACTS", eq(CREATE_GUARD_FIELDS, ["name", "state", "invoice_date", "create_date", "amount_total"]));
{
  const inv = (over) => ({ id: 1, state: "posted", invoice_date: "2026-07-15", create_date: "2026-07-15 10:00:00", ...over });
  ok("dupes: facture du mois courant détectée", duplicateInvoices([inv()], "2026-07").length === 1);
  ok("dupes: mois différent → []", duplicateInvoices([inv()], "2026-06").length === 0);
  ok("dupes: state=cancel ignoré", duplicateInvoices([inv({ state: "cancel" })], "2026-07").length === 0);
  ok("dupes: invoice_date absent → repli create_date", duplicateInvoices([inv({ invoice_date: false })], "2026-07").length === 1);
  ok("dupes: aucune date → non compté", duplicateInvoices([inv({ invoice_date: false, create_date: false })], "2026-07").length === 0);
  ok("dupes: entrées dégénérées → []", eq(duplicateInvoices("x", "2026-07"), []) && eq(duplicateInvoices([inv()], ""), []));
}
{
  const t = formatCreateGuardBlock([{ id: 10, name: "FAC/2026/00004", invoice_date: "2026-07-01" }]);
  ok("formatCreateGuardBlock: blocage explicite + créance + force_create",
    t.includes("ANTI-DOUBLE-CRÉATION") && t.includes('"id":10') && t.includes("2e créance") && t.includes("force_create"));
}

ok("piège: non concernés → null",
  pitfallWarning("call_model_method", { model: "sale.subscription", method: "action_post" }) === null &&
  pitfallWarning("call_model_method", { model: "res.partner", method: "generate_invoice" }) === null &&
  pitfallWarning("update_record", { model: "sale.subscription", method: "generate_invoice" }) === null &&
  pitfallWarning("call_model_method", {}) === null);

// ── parseEnvText (fichier KEY=value, convention .claude/secrets) ──
{
  const env = parseEnvText("# commentaire\nNTFY_URL=https://ntfy.example.com\nNTFY_TOPIC=acme-alerts \n\nmauvaise ligne\nNTFY_USER=admin\r\nNTFY_PASS=secret");
  ok("env: parse KEY=value + trim + CRLF", env.NTFY_URL === "https://ntfy.example.com" && env.NTFY_TOPIC === "acme-alerts" && env.NTFY_USER === "admin" && env.NTFY_PASS === "secret");
  ok("env: commentaires/lignes malformées ignorés", !("mauvaise" in env) && Object.keys(env).length === 4);
}
ok("env: valeur avec '=' conservée entière", parseEnvText("K=a=b").K === "a=b");
ok("env: non-string → {} (fail-silent)", eq(parseEnvText(null), {}) && eq(parseEnvText(42), {}));

// ── canaryRequest (requête NTFY prête à fetch) ──
{
  const r = canaryRequest({ NTFY_URL: "https://ntfy.example.com/", NTFY_TOPIC: "acme-alerts", NTFY_USER: "admin", NTFY_PASS: "pw" }, "Garde Odoo", "🛑 blocage");
  ok("canary: URL = base sans slash final + topic", r.url === "https://ntfy.example.com/acme-alerts");
  ok("canary: POST + body = message UTF-8 intact", r.options.method === "POST" && r.options.body === "🛑 blocage");
  ok("canary: headers Title/Priority/Tags exacts", r.options.headers.Title === "Garde Odoo" && r.options.headers.Priority === "high" && r.options.headers.Tags === "rotating_light,odoo");
  ok("canary: auth Basic base64(user:pass)", r.options.headers.Authorization === "Basic " + Buffer.from("admin:pw").toString("base64"));
}
{
  const r = canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "Déclenchée à 3 €", "m");
  ok("canary: Title purgé du non-ASCII (header HTTP)", r.options.headers.Title === "Dclenche  3");
  ok("canary: sans user/pass → pas d'Authorization", !("Authorization" in r.options.headers));
}
ok("canary: Title vide après purge → fallback 'Odoo MCP'", canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "🛑", "m").options.headers.Title === "Odoo MCP");
ok("canary: message null/undefined → corps vide (jamais 'null' envoyé)", canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "T", null).options.body === "" && canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "T", undefined).options.body === "");
ok("canary: conf incomplète → null (URL ou topic manquant/vide)",
  canaryRequest({ NTFY_TOPIC: "t" }, "T", "m") === null &&
  canaryRequest({ NTFY_URL: "https://x" }, "T", "m") === null &&
  canaryRequest({ NTFY_URL: "", NTFY_TOPIC: "t" }, "T", "m") === null &&
  canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "" }, "T", "m") === null &&
  canaryRequest(null, "T", "m") === null);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
