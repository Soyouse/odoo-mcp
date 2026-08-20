// Tests lib/readback.js — logique PURE du « MCP voyant » + garde anti-doublon.
// Zéro I/O : on prouve les PLANS (quoi relire, quoi bloquer), pas l'exécution
// (couverte par handlers.test.js avec backend factice).
// Runner = vitest (mutation Stryker perTest).
// ⚠️ perTest : TOUT appel au code muté DOIT vivre DANS le callback d'un `it()`
//    (fixtures = thunks ; une const évaluée au chargement = faux survivant).
import { describe, it, expect } from "vitest";
import {
  toIdArray, extractCommandIds, parseCreatedId, parseSearchRecords,
  readbackPlan, cascadePlan, sendGuardPlan, stableFieldsFor,
  formatReadback, formatGuardBlock, GUARD_FIELDS,
  MAIL_SCAN_TOOLS, mailSnapshotCall, mailScanCall, latestMessageId, formatMailReport,
  intersectFields, formatGuardIncapable, pitfallWarning,
  createGuardPlan, duplicateInvoices, formatCreateGuardBlock, CREATE_GUARD_FIELDS,
  parseEnvText, canaryRequest,
} from "./readback.js";

describe("toIdArray", () => {
  it("toIdArray: tableau d'ints", () => expect(toIdArray([1, 2, 3])).toEqual([1, 2, 3]));
  it("toIdArray: string JSON (forme backend)", () => expect(toIdArray("[9]")).toEqual([9]));
  it("toIdArray: mixte int+string → [] (pas un pur tableau d'ids)", () => expect(toIdArray([1, "a"])).toEqual([]));
  it("toIdArray: objet/null/négatifs → []", () => {
    expect(toIdArray({})).toEqual([]);
    expect(toIdArray(null)).toEqual([]);
    expect(toIdArray([-1])).toEqual([]);
  });
  it("toIdArray: float / zéro → []", () => {
    expect(toIdArray([1.5])).toEqual([]);
    expect(toIdArray([0])).toEqual([]);
  });
  it("toIdArray: string JSON invalide → []", () => expect(toIdArray("{bad")).toEqual([]));
});

describe("extractCommandIds (commandes ORM x2many)", () => {
  it("commands: (6,0,[ids])", () => expect(extractCommandIds([[6, 0, [9, 10]]])).toEqual([9, 10]));
  it("commands: (4,id) + id nu + doublon dédupliqué", () => expect(extractCommandIds([[4, 9], 9, [4, 11]])).toEqual([9, 11]));
  it("commands: non-tableau → []", () => expect(extractCommandIds("x")).toEqual([]));
  it("commands: (5,x)/(3,x) IGNORÉS (seuls 4 et 6 portent des ids ajoutés)", () => expect(extractCommandIds([[5], [3, 9]])).toEqual([]));
  it("commands: id nu SEUL extrait", () => expect(extractCommandIds([7])).toEqual([7]));
  it("commands: 0 et négatif nus rejetés", () => expect(extractCommandIds([0, -2])).toEqual([]));
  it("commands: (6,0,[...]) filtre 0/négatif/float", () => expect(extractCommandIds([[6, 0, [0, -1, 2.5, 9]]])).toEqual([9]));
  it("commands: (6,0,scalaire) → [] (pas de spread sauvage)", () => expect(extractCommandIds([[6, 0, 5]])).toEqual([]));
  it("commands: (3,0,[ids]) IGNORÉ (3 ≠ ajout)", () => expect(extractCommandIds([[3, 0, [9]]])).toEqual([]));
});

describe("parseCreatedId / parseSearchRecords", () => {
  it("createdId: JSON {record:{id}}", () => expect(parseCreatedId('{"success":true,"record":{"id":42,"display_name":"X"}}')).toBe(42));
  it("createdId: fallback message 'with ID N'", () => expect(parseCreatedId("Successfully created account.move record with ID 9")).toBe(9));
  it("createdId: illisible → null", () => {
    expect(parseCreatedId("rien")).toBe(null);
    expect(parseCreatedId(undefined)).toBe(null);
  });
  it("createdId: id 0 / record absent → null", () => {
    expect(parseCreatedId('{"record":{"id":0}}')).toBe(null);
    expect(parseCreatedId('{"success":true}')).toBe(null);
  });
  it("createdId: multi-digits capturés (42, pas 4)", () => expect(parseCreatedId("Successfully created record with ID 42")).toBe(42));
  it("searchRecords: {records:[...]}", () => expect(parseSearchRecords('{"records":[{"id":1}],"total":1}')).toEqual([{ id: 1 }]));
  it("searchRecords: JSON sans records / invalide → null", () => {
    expect(parseSearchRecords("{}")).toBe(null);
    expect(parseSearchRecords("x")).toBe(null);
  });
});

describe("readbackPlan", () => {
  it("plan update_record → ids=[record_id] + champs stables account.move", () => {
    const p = readbackPlan("update_record", { model: "account.move", record_id: 9 }, "");
    expect(p.ids).toEqual([9]);
    expect(p.fields).toContain("is_move_sent");
    expect(p.fields).toContain("payment_state");
  });
  it("plan create_record → id parsé du résultat + fallback fields", () => {
    const p = readbackPlan("create_record", { model: "x.inconnu", values: {} }, '{"record":{"id":7}}');
    expect(p.ids).toEqual([7]);
    expect(p.fields).toEqual(["display_name", "write_date"]);
  });
  it("plan call_model_method → ids=arguments[0] (le cas réel : retour null)", () => {
    const p = readbackPlan("call_model_method", { model: "sale.subscription", method: "generate_invoice", arguments: [[3]] }, "null");
    expect(p.ids).toEqual([3]);
    expect(p.fields).toContain("invoice_ids");
  });
  it("plan call_model_method: arguments en string JSON", () => {
    const p = readbackPlan("call_model_method", { model: "account.move", method: "action_post", arguments: "[[9]]" }, "null");
    expect(p.ids).toEqual([9]);
  });
  it("plan: outil lecture → null", () => expect(readbackPlan("search_records", { model: "res.partner" }, "")).toBe(null));
  it("plan: delete_record → null (record mort)", () => expect(readbackPlan("delete_record", { model: "res.partner", record_id: 1 }, "")).toBe(null));
  it("plan: sans model / sans ids → null", () => {
    expect(readbackPlan("update_record", { record_id: 1 }, "")).toBe(null);
    expect(readbackPlan("call_model_method", { model: "res.partner", arguments: [] }, "")).toBe(null);
  });
  it("plan: cap à 10 ids relus", () => {
    const p = readbackPlan("call_model_method", { model: "res.partner", arguments: [[...Array(20).keys()].map((i) => i + 1)] }, "");
    expect(p.ids).toHaveLength(10);
  });
  it("plan update EXACT (model+ids+fields)", () => {
    const p = readbackPlan("update_record", { model: "account.move", record_id: 9 }, "");
    expect(p).toEqual({ model: "account.move", ids: [9], fields: ["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"] });
  });
  it("plan: model chaîne vide → null", () => expect(readbackPlan("update_record", { model: "", record_id: 9 }, "")).toBe(null));
  it("plan: record_id 0 / négatif / float → null", () => {
    expect(readbackPlan("update_record", { model: "x", record_id: 0 }, "")).toBe(null);
    expect(readbackPlan("update_record", { model: "x", record_id: -3 }, "")).toBe(null);
    expect(readbackPlan("update_record", { model: "x", record_id: 1.5 }, "")).toBe(null);
  });
  it("plan: callArgs undefined → null (pas de crash)", () => expect(readbackPlan("update_record", undefined, "")).toBe(null));
  it("plan: create sans id parsable → null", () => expect(readbackPlan("create_record", { model: "x" }, "aucun id")).toBe(null));
  it("plan: call_model_method arguments non-tableau → null", () => expect(readbackPlan("call_model_method", { model: "x", arguments: { vals: 1 } }, "")).toBe(null));
  it("plan: outil lecture MÊME avec arguments[[ids]] → null", () => expect(readbackPlan("get_record", { model: "x", arguments: [[1]] }, "")).toBe(null));
});

describe("cascadePlan (abo → factures)", () => {
  it("cascade abo → account.move, ids triés récents d'abord", () => {
    const c = cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [9, 12, 10] }]);
    expect(c.model).toBe("account.move");
    expect(c.ids).toEqual([12, 10, 9]);
  });
  it("cascade: autre modèle / sans factures → null", () => {
    expect(cascadePlan("account.move", [{ id: 9 }])).toBe(null);
    expect(cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [] }])).toBe(null);
  });
  it("cascade: cap à 5 factures les plus récentes", () => {
    const c = cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [1, 2, 3, 4, 5, 6, 7] }]);
    expect(c.ids).toEqual([7, 6, 5, 4, 3]);
  });
  it("cascade: multi-abos fusionnés + dédup + fields account.move EXACTS", () => {
    const c = cascadePlan("sale.subscription", [{ id: 3, invoice_ids: [9] }, { id: 4, invoice_ids: [9, 11] }]);
    expect(c.ids).toEqual([11, 9]);
    expect(c.fields).toEqual(["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"]);
  });
  it("cascade: records non-tableau → null (pas de crash)", () => expect(cascadePlan("sale.subscription", "pas-un-tableau")).toBe(null));
  it("cascade: autre modèle MÊME avec invoice_ids → null", () => expect(cascadePlan("account.move", [{ id: 1, invoice_ids: [9] }])).toBe(null));
});

describe("sendGuardPlan (anti-doublon)", () => {
  it("garde: call_model_method account.move *send* → ids gardés", () => {
    const g = sendGuardPlan("call_model_method", { model: "account.move", method: "action_send_and_print", arguments: [[9]] });
    expect(g.ids).toEqual([9]);
  });
  it("garde: wizard account.move.send (create) → move_ids extraits", () => {
    const g = sendGuardPlan("create_record", { model: "account.move.send", values: { move_ids: [[6, 0, [9]]] } });
    expect(g.model).toBe("account.move");
    expect(g.ids).toEqual([9]);
  });
  it("garde: méthodes non-send / autres modèles → null", () => {
    expect(sendGuardPlan("call_model_method", { model: "account.move", method: "action_post", arguments: [[9]] })).toBe(null);
    expect(sendGuardPlan("call_model_method", { model: "res.partner", method: "send_thing", arguments: [[1]] })).toBe(null);
    expect(sendGuardPlan("update_record", { model: "account.move", record_id: 9 })).toBe(null);
  });
  it("garde: send sans ids identifiables → null (le hook provenance couvre déjà)", () => {
    expect(sendGuardPlan("call_model_method", { model: "account.move", method: "send_and_print", arguments: [] })).toBe(null);
  });
  it("GUARD_FIELDS contient is_move_sent (le champ décisif)", () => expect(GUARD_FIELDS).toContain("is_move_sent"));
  it("GUARD_FIELDS EXACTS", () => expect(GUARD_FIELDS).toEqual(["name", "state", "payment_state", "is_move_sent"]));
  it("garde: match send insensible à la casse", () => {
    const g = sendGuardPlan("call_model_method", { model: "account.move", method: "SEND_AND_PRINT", arguments: [[9]] });
    expect(g.ids).toEqual([9]);
  });
  it("garde: modèle préfixé (x.account.move.send) → null (startsWith strict)", () => {
    expect(sendGuardPlan("create_record", { model: "x.account.move.send", values: { move_ids: [[6, 0, [9]]] } })).toBe(null);
  });
  it("garde: arguments en string JSON compris", () => {
    const g = sendGuardPlan("call_model_method", { model: "account.move", method: "send_and_print", arguments: "[[7,8]]" });
    expect(g.ids).toEqual([7, 8]);
  });
});

describe("stableFieldsFor", () => {
  it("stableFieldsFor: fallback modèles inconnus", () => expect(stableFieldsFor("x.y")).toEqual(["display_name", "write_date"]));
  it("fields account.move EXACTS", () => expect(stableFieldsFor("account.move")).toEqual(["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"]));
  it("fields sale.subscription EXACTS", () => expect(stableFieldsFor("sale.subscription")).toEqual(["display_name", "invoice_ids"]));
  it("fields sale.order EXACTS", () => expect(stableFieldsFor("sale.order")).toEqual(["name", "state", "invoice_status", "amount_total"]));
  it("fields res.partner EXACTS", () => expect(stableFieldsFor("res.partner")).toEqual(["display_name", "email", "phone", "city"]));
});

describe("formatage (formatReadback / formatGuardBlock)", () => {
  it("formatReadback: état réel + ids introuvables signalés", () => {
    const t = formatReadback("account.move", [{ id: 9, name: "FAC/2026/00003", is_move_sent: true }], [9, 10]);
    expect(t).toContain("ÉTAT RÉEL");
    expect(t).toContain('"id":9');
    expect(t).toContain('"is_move_sent":true');
    expect(t).toContain("INTROUVABLES");
    expect(t).toContain("#10");
  });
  it("formatGuardBlock: blocage explicite + issue force_resend", () => {
    const t = formatGuardBlock([{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid" }]);
    expect(t).toContain("GARDE ANTI-DOUBLON");
    expect(t).toContain("FAC/2026/00003");
    expect(t).toContain("force_resend");
  });
  it("formatReadback EXACT (JSON récoltable par le hook provenance)", () => {
    const t = formatReadback("account.move", [{ id: 9, name: "F", is_move_sent: true }], [9]);
    expect(t).toBe('═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\naccount.move {"id":9,"name":"F","is_move_sent":true}');
  });
  it("formatReadback EXACT (manquants listés)", () => {
    const t = formatReadback("account.move", [{ id: 9, name: "F" }], [9, 10, 11]);
    expect(t).toBe('═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\naccount.move {"id":9,"name":"F"}\n⚠️ INTROUVABLES en base : #10, #11 (supprimés ou jamais créés)');
  });
  it("formatGuardBlock EXACT", () => {
    const t = formatGuardBlock([{ id: 9, name: "N", state: "posted", payment_state: "not_paid" }]);
    expect(t).toBe("🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ — facture(s) DÉJÀ ENVOYÉE(S) au client :\n" +
      "account.move #9 N — is_move_sent: true · state: posted · payment_state: not_paid\n" +
      "Renvoyer = email en double chez le client (incident du 2026-07-01). Si le renvoi est VOULU et assumé, rappelle avec args.force_resend: true.");
  });
  // Multi-éléments pour tuer les mutants de séparateurs (join sur 1 élément = indétectable).
  it("formatReadback EXACT multi-records (séparateur \\n)", () => {
    const t = formatReadback("res.partner", [{ id: 1, display_name: "A" }, { id: 2, display_name: "B" }], [1, 2]);
    expect(t).toBe('═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\nres.partner {"id":1,"display_name":"A"}\nres.partner {"id":2,"display_name":"B"}');
  });
  it("formatGuardBlock EXACT multi-factures (séparateur \\n)", () => {
    const t = formatGuardBlock([
      { id: 9, name: "A", state: "posted", payment_state: "not_paid" },
      { id: 10, name: "B", state: "posted", payment_state: "paid" },
    ]);
    expect(t).toBe("🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ — facture(s) DÉJÀ ENVOYÉE(S) au client :\n" +
      "account.move #9 A — is_move_sent: true · state: posted · payment_state: not_paid\n" +
      "account.move #10 B — is_move_sent: true · state: posted · payment_state: paid\n" +
      "Renvoyer = email en double chez le client (incident du 2026-07-01). Si le renvoi est VOULU et assumé, rappelle avec args.force_resend: true.");
  });
  it("formatGuardBlock: name absent → chaîne vide (pas 'undefined')", () => {
    const t = formatGuardBlock([{ id: 9, state: "posted", payment_state: "not_paid" }]);
    expect(t).toContain("account.move #9  — is_move_sent");
    expect(t).not.toContain("undefined");
  });
});

describe("Scan mail (emails partis pendant l'appel)", () => {
  it("MAIL_SCAN_TOOLS EXACT (les 4 outils d'écriture)", () => {
    expect([...MAIL_SCAN_TOOLS].sort()).toEqual(["call_model_method", "create_record", "post_message", "update_record"]);
  });
  it("mailSnapshotCall EXACT (dernier id, 1 record)", () => {
    expect(mailSnapshotCall()).toEqual({ model: "mail.message", domain: [], fields: ["id"], limit: 1, order: "id desc" });
  });
  it("mailScanCall EXACT (id > baseline + destinataires non vides)", () => {
    expect(mailScanCall(100)).toEqual({
      model: "mail.message",
      domain: [["id", ">", 100], ["partner_ids", "!=", false]],
      fields: ["message_type", "subject", "email_from", "partner_ids", "model", "res_id"],
      limit: 10,
      order: "id asc",
    });
  });
  it("latestMessageId: [{id:5}] → 5 · [] → 0 (base vide valide) · null/illisible → null", () => {
    expect(latestMessageId([{ id: 5 }])).toBe(5);
    expect(latestMessageId([])).toBe(0);
    expect(latestMessageId(null)).toBe(null);
    expect(latestMessageId([{ id: "x" }])).toBe(null);
    expect(latestMessageId([{}])).toBe(null);
  });
  it("formatMailReport EXACT multi-messages", () => {
    const t = formatMailReport([
      { id: 101, subject: "Facture", partner_ids: [16] },
      { id: 102, subject: "Relance", partner_ids: [16] },
    ]);
    expect(t).toBe("📧 2 MESSAGE(S) PARTI(S) VERS DES DESTINATAIRES PENDANT L'APPEL — en tenir compte AVANT tout renvoi :\n" +
      'mail.message {"id":101,"subject":"Facture","partner_ids":[16]}\n' +
      'mail.message {"id":102,"subject":"Relance","partner_ids":[16]}');
  });
  it("formatMailReport: vide/illisible → certitude « aucun email »", () => {
    expect(formatMailReport([])).toBe("📧 Aucun destinataire notifié pendant l'appel (aucun email parti).");
    expect(formatMailReport(null)).toBe("📧 Aucun destinataire notifié pendant l'appel (aucun email parti).");
  });
});

describe("Capability detection (souhaité ∩ réel)", () => {
  it("intersect: garde l'ordre des souhaités, omet les absents", () => {
    expect(intersectFields(["a", "b", "c"], ["c", "a", "x"])).toEqual(["a", "c"]);
  });
  it("intersect: liste réelle indisponible (null/vide) → souhaits INCHANGÉS (fail-safe)", () => {
    expect(intersectFields(["a", "b"], null)).toEqual(["a", "b"]);
    expect(intersectFields(["a", "b"], [])).toEqual(["a", "b"]);
  });
  it("intersect: intersection vide → fallback display_name (jamais une liste vide)", () => {
    expect(intersectFields(["x", "y"], ["a", "display_name"])).toEqual(["display_name"]);
    expect(intersectFields(["x"], ["a", "b"])).toEqual(["display_name"]);
  });
  it("intersect: fallback garde write_date SI présent", () => {
    expect(intersectFields(["x"], ["write_date", "a"])).toEqual(["display_name", "write_date"]);
  });
  it("formatGuardIncapable: annonce l'incapacité + issue force_resend", () => {
    const t = formatGuardIncapable();
    expect(t).toContain("n'expose PAS");
    expect(t).toContain("is_move_sent");
    expect(t).toContain("force_resend");
  });
});

describe("Pièges connus (savoir métier dans le tuyau)", () => {
  it("piège: generate_invoice abo → warning invoicing_mode/doublon", () => {
    const w = pitfallWarning("call_model_method", { model: "sale.subscription", method: "generate_invoice" });
    expect(typeof w).toBe("string");
    expect(w).toContain("PIÈGE CONNU");
    expect(w).toContain("invoice_send");
    expect(w).toContain("NE PAS renvoyer");
  });
  it("piège: create_invoice abo matche aussi (/invoice/i)", () => {
    expect(pitfallWarning("call_model_method", { model: "sale.subscription", method: "create_invoice" })).not.toBe(null);
  });
  it("piège: send_mail template → warning auto-delete + délivrabilité", () => {
    expect(String(pitfallWarning("call_model_method", { model: "mail.template", method: "send_mail" }))).toContain("AUTO-SUPPRIMÉ");
    expect(pitfallWarning("call_model_method", { model: "mail.template", method: "SEND_MAIL" })).not.toBe(null);
    expect(pitfallWarning("call_model_method", { model: "mail.template", method: "send_mail_x" })).toBe(null);
  });
  it("piège: action_cancel devis → warning unlock/wizard", () => {
    expect(String(pitfallWarning("call_model_method", { model: "sale.order", method: "action_cancel" }))).toContain("action_unlock");
  });
  it("piège: non concernés → null", () => {
    expect(pitfallWarning("call_model_method", { model: "sale.subscription", method: "action_post" })).toBe(null);
    expect(pitfallWarning("call_model_method", { model: "res.partner", method: "generate_invoice" })).toBe(null);
    expect(pitfallWarning("update_record", { model: "sale.subscription", method: "generate_invoice" })).toBe(null);
    expect(pitfallWarning("call_model_method", {})).toBe(null);
  });
});

describe("Garde anti-double-création", () => {
  const inv = (over) => ({ id: 1, state: "posted", invoice_date: "2026-07-15", create_date: "2026-07-15 10:00:00", ...over });

  it("création: generate_invoice → plan {sale.subscription, ids}", () => {
    const g = createGuardPlan("call_model_method", { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] });
    expect(g.model).toBe("sale.subscription");
    expect(g.ids).toEqual([7]);
  });
  it("création: create_invoice matche, arguments string JSON compris", () => {
    expect(createGuardPlan("call_model_method", { model: "sale.subscription", method: "create_invoice", arguments: "[[7]]" })).not.toBe(null);
  });
  it("création: méthodes de LECTURE (action_view_account_invoice_ids) → null", () => {
    expect(createGuardPlan("call_model_method", { model: "sale.subscription", method: "action_view_account_invoice_ids", arguments: [[7]] })).toBe(null);
  });
  it("création: autres modèles/outils/sans ids → null", () => {
    expect(createGuardPlan("call_model_method", { model: "account.move", method: "generate_invoice", arguments: [[9]] })).toBe(null);
    expect(createGuardPlan("create_record", { model: "sale.subscription", method: "generate_invoice" })).toBe(null);
    expect(createGuardPlan("call_model_method", { model: "sale.subscription", method: "generate_invoice", arguments: [] })).toBe(null);
  });
  it("CREATE_GUARD_FIELDS EXACTS", () => {
    expect(CREATE_GUARD_FIELDS).toEqual(["name", "state", "invoice_date", "create_date", "amount_total"]);
  });
  it("dupes: facture du mois courant détectée", () => expect(duplicateInvoices([inv()], "2026-07")).toHaveLength(1));
  it("dupes: mois différent → []", () => expect(duplicateInvoices([inv()], "2026-06")).toHaveLength(0));
  it("dupes: state=cancel ignoré", () => expect(duplicateInvoices([inv({ state: "cancel" })], "2026-07")).toHaveLength(0));
  it("dupes: invoice_date absent → repli create_date", () => expect(duplicateInvoices([inv({ invoice_date: false })], "2026-07")).toHaveLength(1));
  it("dupes: aucune date → non compté", () => expect(duplicateInvoices([inv({ invoice_date: false, create_date: false })], "2026-07")).toHaveLength(0));
  it("dupes: entrées dégénérées → []", () => {
    expect(duplicateInvoices("x", "2026-07")).toEqual([]);
    expect(duplicateInvoices([inv()], "")).toEqual([]);
  });
  it("formatCreateGuardBlock: blocage explicite + créance + force_create", () => {
    const t = formatCreateGuardBlock([{ id: 10, name: "FAC/2026/00004", invoice_date: "2026-07-01" }]);
    expect(t).toContain("ANTI-DOUBLE-CRÉATION");
    expect(t).toContain('"id":10');
    expect(t).toContain("2e créance");
    expect(t).toContain("force_create");
  });
});

describe("parseEnvText (fichier KEY=value, convention .claude/secrets)", () => {
  const text = () => "# commentaire\nNTFY_URL=https://ntfy.example.com\nNTFY_TOPIC=acme-alerts \n\nmauvaise ligne\nNTFY_USER=admin\r\nNTFY_PASS=secret";

  it("env: parse KEY=value + trim + CRLF", () => {
    const env = parseEnvText(text());
    expect(env.NTFY_URL).toBe("https://ntfy.example.com");
    expect(env.NTFY_TOPIC).toBe("acme-alerts");
    expect(env.NTFY_USER).toBe("admin");
    expect(env.NTFY_PASS).toBe("secret");
  });
  it("env: commentaires/lignes malformées ignorés", () => {
    const env = parseEnvText(text());
    expect("mauvaise" in env).toBe(false);
    expect(Object.keys(env)).toHaveLength(4);
  });
  it("env: valeur avec '=' conservée entière", () => expect(parseEnvText("K=a=b").K).toBe("a=b"));
  it("env: non-string → {} (fail-silent)", () => {
    expect(parseEnvText(null)).toEqual({});
    expect(parseEnvText(42)).toEqual({});
  });
});

describe("canaryRequest (requête NTFY prête à fetch)", () => {
  const conf = () => ({ NTFY_URL: "https://ntfy.example.com/", NTFY_TOPIC: "acme-alerts", NTFY_USER: "admin", NTFY_PASS: "pw" });

  it("canary: URL = base sans slash final + topic", () => {
    expect(canaryRequest(conf(), "Garde Odoo", "🛑 blocage").url).toBe("https://ntfy.example.com/acme-alerts");
  });
  it("canary: POST + body = message UTF-8 intact", () => {
    const r = canaryRequest(conf(), "Garde Odoo", "🛑 blocage");
    expect(r.options.method).toBe("POST");
    expect(r.options.body).toBe("🛑 blocage");
  });
  it("canary: headers Title/Priority/Tags exacts", () => {
    const h = canaryRequest(conf(), "Garde Odoo", "🛑 blocage").options.headers;
    expect(h.Title).toBe("Garde Odoo");
    expect(h.Priority).toBe("high");
    expect(h.Tags).toBe("rotating_light,odoo");
  });
  it("canary: auth Basic base64(user:pass)", () => {
    const h = canaryRequest(conf(), "Garde Odoo", "🛑 blocage").options.headers;
    expect(h.Authorization).toBe("Basic " + Buffer.from("admin:pw").toString("base64"));
  });
  it("canary: Title purgé du non-ASCII (header HTTP)", () => {
    const r = canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "Déclenchée à 3 €", "m");
    expect(r.options.headers.Title).toBe("Dclenche  3");
  });
  it("canary: sans user/pass → pas d'Authorization", () => {
    const r = canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "Déclenchée à 3 €", "m");
    expect("Authorization" in r.options.headers).toBe(false);
  });
  it("canary: Title vide après purge → fallback 'Odoo MCP'", () => {
    expect(canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "🛑", "m").options.headers.Title).toBe("Odoo MCP");
  });
  it("canary: message null/undefined → corps vide (jamais 'null' envoyé)", () => {
    expect(canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "T", null).options.body).toBe("");
    expect(canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "t" }, "T", undefined).options.body).toBe("");
  });
  it("canary: conf incomplète → null (URL ou topic manquant/vide)", () => {
    expect(canaryRequest({ NTFY_TOPIC: "t" }, "T", "m")).toBe(null);
    expect(canaryRequest({ NTFY_URL: "https://x" }, "T", "m")).toBe(null);
    expect(canaryRequest({ NTFY_URL: "", NTFY_TOPIC: "t" }, "T", "m")).toBe(null);
    expect(canaryRequest({ NTFY_URL: "https://x", NTFY_TOPIC: "" }, "T", "m")).toBe(null);
    expect(canaryRequest(null, "T", "m")).toBe(null);
  });
});
