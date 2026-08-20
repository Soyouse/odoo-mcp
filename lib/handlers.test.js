// Tests lib/handlers.js — logique métier avec un BACKEND FACTICE (zéro spawn).
// Prouve : formatage discover, validation précoce, routage isError, enrichissement
// champs (resource), et fail-safe transport. Deps réelles injectées (validate+fields).
// Runner = vitest. ⚠️ handlers.js = ORCHESTRATION : couvert par ces tests
// COMPORTEMENTAUX, PAS par la mutation (cf stryker.conf.json).
import { describe, it, expect } from "vitest";
import { makeHandlers } from "./handlers.js";
import * as validate from "./validate.js";
import * as fields from "./fields.js";
import * as readback from "./readback.js";

const H = makeHandlers({ ...validate, ...fields, ...readback });
const txt = (r) => (r.content || []).map((c) => c.text || "").join("");

// Backend factice paramétrable : on contrôle chaque réponse, AUCUN process.
// `callImpl(name, args)` (optionnel) : réponse par appel — sert aux tests
// voyant/garde où l'appel d'écriture et les relectures search_records diffèrent.
// Chaque appel est journalisé dans `.calls` (assertions sur qui a été appelé).
function fakeBackend(opts = {}) {
  return {
    _tools: opts.tools ?? [{ name: "search_records", description: "Search", inputSchema: { properties: { model: { type: "string", description: "m" } }, required: ["model"] } }],
    calls: [],
    knownToolNames() { return opts.known ?? null; },
    async getTools() { if (opts.getToolsThrows) throw new Error("backend down"); return this._tools; },
    async callTool(name, args) {
      this.calls.push({ name, args });
      if (opts.callImpl) return opts.callImpl(name, args);
      if (opts.callThrows) throw new Error(opts.callThrows);
      return opts.callResult ?? { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }], isError: false };
    },
    async readResource() {
      if (opts.resourceThrows) throw new Error("no resource");
      // Défaut = champs réels d'un serveur « complet » (capability detection
      // laisse alors passer tous nos champs stables — comportement nominal).
      return opts.resourceText ??
        "name:\n  Label: Name\nemail:\n  Label: Email\nphone:\nstate:\npayment_state:\nis_move_sent:\namount_total:\npartner_id:\ndisplay_name:\ninvoice_ids:\nwrite_date:\ncity:\ninvoice_date:\ncreate_date:\n";
    },
    readResourceCached(uri) { return this.readResource(uri); },
  };
}

// Réponse search_records factice (relecture voyant/garde).
const searchResult = (records) => ({ content: [{ type: "text", text: JSON.stringify({ records, total: records.length }) }], isError: false });

// Backend factice « métier » : route les search_records par modèle —
// mail.message (snapshot/scan) séparé des relectures voyant. Chaque test
// fournit sa table `byModel` + la réponse d'écriture `writeResult`.
function bizBackend({ byModel = {}, writeResult, mailSnapshot = [{ id: 100 }], mailScan = [] } = {}) {
  return fakeBackend({
    callImpl: (name, args) => {
      if (name !== "search_records") return writeResult ?? { content: [{ type: "text", text: '{"success":true,"result":null}' }], isError: false };
      if (args.model === "mail.message") {
        // snapshot = domain vide ; scan = domain [id > baseline]
        return searchResult(args.domain.length === 0 ? mailSnapshot : mailScan);
      }
      const recs = byModel[args.model];
      return recs ? searchResult(recs) : { content: [{ type: "text", text: "boom" }], isError: true };
    },
  });
}

describe("handleDiscover", () => {
  it("discover formate les outils (## search_records)", async () => {
    const r = await H.handleDiscover(fakeBackend());
    expect(txt(r)).toContain("## search_records");
    expect(txt(r)).toContain("Odoo CRM tools (1)");
  });
  it("discover marque le param requis avec *", async () => {
    expect(txt(await H.handleDiscover(fakeBackend()))).toContain("model*");
  });
  it("discover backend down → isError + proxy vivant (pas de throw)", async () => {
    const r = await H.handleDiscover(fakeBackend({ getToolsThrows: true }));
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("backend unavailable");
  });
});

describe("handleCall — validation précoce", () => {
  it("call sans tool → erreur immédiate isError", async () => {
    expect((await H.handleCall(fakeBackend(), { tool: "" })).isError).toBe(true);
  });
  it("call args=array → 'must be an object'", async () => {
    expect(txt(await H.handleCall(fakeBackend(), { tool: "search_records", args: [1] }))).toContain("must be an object");
  });
  it("call nom inconnu (cache chaud) → suggestion", async () => {
    const unk = await H.handleCall(fakeBackend({ known: ["search_records", "get_record"] }), { tool: "search_record", args: {} });
    expect(unk.isError).toBe(true);
    expect(txt(unk)).toContain("search_records");
  });
});

describe("handleCall — succès et erreurs d'outil", () => {
  it("call OK → content renvoyé sans isError", async () => {
    const r = await H.handleCall(fakeBackend(), { tool: "search_records", args: { model: "res.partner" } });
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toContain("id");
  });
  it("Invalid field (isError) → enrichi (Champs valides + name)", async () => {
    const be = fakeBackend({ callResult: { content: [{ type: "text", text: "Invalid field 'naem' in request" }], isError: true } });
    const r = await H.handleCall(be, { tool: "search_records", args: { model: "res.partner", fields: ["naem"] } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("Champs valides");
    expect(txt(r)).toContain("name");
  });
  it("isError sans model → propagé tel quel + isError", async () => {
    // isError SANS model → pas d'enrichissement → message propagé + isError gardé
    const be = fakeBackend({ callResult: { content: [{ type: "text", text: "Invalid field 'naem' in request" }], isError: true } });
    const r = await H.handleCall(be, { tool: "search_records", args: {} });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("Invalid field");
  });
  it("resource KO → fail-safe, isError + message d'origine", async () => {
    // enrichissement demandé mais resource KO → fail-safe : message d'origine
    const be = fakeBackend({ callResult: { content: [{ type: "text", text: "Invalid field 'naem'" }], isError: true }, resourceThrows: true });
    const r = await H.handleCall(be, { tool: "search_records", args: { model: "res.partner" } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("Invalid field");
  });
  it("transport throw → isError 'Error:' (jamais de throw remonté)", async () => {
    const r = await H.handleCall(fakeBackend({ callThrows: "Backend not running" }), { tool: "search_records", args: { model: "res.partner" } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("Backend not running");
  });
  it("transport throw 'Invalid field' + model → enrichi", async () => {
    const r = await H.handleCall(fakeBackend({ callThrows: "Invalid field 'naem'" }), { tool: "search_records", args: { model: "res.partner" } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("Champs valides");
  });
});

describe("MCP VOYANT : relecture post-écriture", () => {
  // update_record OK → une relecture search_records est appendue au résultat.
  const updateMove = async () => {
    const be = bizBackend({
      byModel: { "account.move": [{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid", is_move_sent: true }] },
      writeResult: { content: [{ type: "text", text: '{"success":true,"record":{"id":9}}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "update_record", args: { model: "account.move", record_id: 9, values: { ref: "x" } } });
    return { be, r };
  };

  it("voyant: update → relecture appendue (ÉTAT RÉEL, JSON récoltable)", async () => {
    const { r } = await updateMove();
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toContain("ÉTAT RÉEL");
    expect(txt(r)).toContain('"is_move_sent":true');
    expect(txt(r)).toContain('"id":9');
  });
  it("voyant: relecture = search_records id in [9] + champs stables", async () => {
    const { be } = await updateMove();
    const search = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    expect(JSON.stringify(search.args.domain)).toBe('[["id","in",[9]]]');
    expect(search.args.fields).toContain("payment_state");
  });

  // call_model_method retour null (cas réel du doublon) → relecture + cascade abo→factures.
  const generateInvoice = async () => {
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 3, display_name: "SUB00007", invoice_ids: [9] }],
        "account.move": [{ id: 9, name: "FAC/2026/00003", is_move_sent: true }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[3]] } });
    return { be, r };
  };

  it("voyant: méthode muette (null) → état réel quand même relu", async () => {
    const { r } = await generateInvoice();
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toContain("ÉTAT RÉEL");
    expect(txt(r)).toContain("SUB00007");
  });
  it("voyant: cascade abo → relecture des factures liées", async () => {
    const { be, r } = await generateInvoice();
    const cascade = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    expect(JSON.stringify(cascade.args.domain)).toBe('[["id","in",[9]]]');
    expect(txt(r)).toContain("FAC/2026/00003");
  });
  it("piège: generate_invoice → PIÈGE CONNU appendu (agent sans skill prévenu)", async () => {
    const { r } = await generateInvoice();
    expect(txt(r)).toContain("PIÈGE CONNU");
    expect(txt(r)).toContain("invoice_send");
  });

  // Relecture KO → l'écriture reste un SUCCÈS + warning explicite (fail-safe).
  const createWithBrokenReadback = async () => {
    const be = fakeBackend({
      callImpl: (name) => name === "search_records"
        ? { content: [{ type: "text", text: "boom" }], isError: true }
        : { content: [{ type: "text", text: '{"record":{"id":9}}' }], isError: false },
    });
    return H.handleCall(be, { tool: "create_record", args: { model: "res.partner", values: { name: "X" } } });
  };

  it("voyant: relecture KO → succès conservé + warning 'vérifie'", async () => {
    const r = await createWithBrokenReadback();
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toContain("relecture de vérification KO");
  });
  it("voyant: snapshot mail KO → l'incertitude est DITE (pas de faux 'aucun email')", async () => {
    expect(txt(await createWithBrokenReadback())).toContain("emails IMPOSSIBLE");
  });
  it("voyant: outil lecture → un seul appel backend", async () => {
    // Outil de LECTURE → aucune relecture ni scan mail (un seul appel backend).
    const be = fakeBackend();
    await H.handleCall(be, { tool: "search_records", args: { model: "res.partner" } });
    expect(be.calls).toHaveLength(1);
  });
});

describe("CAPABILITY DETECTION : champs souhaités ∩ champs réels", () => {
  it("capability: champs relus = souhaités ∩ réels (payment_state absent → omis)", async () => {
    // Serveur qui n'a QUE name+state (pas payment_state/is_move_sent) →
    // la relecture ne demande que l'intersection (zéro « Invalid field »).
    const be = fakeBackend({
      resourceText: "name:\n  Label: Name\nstate:\n  Label: Status\n",
      callImpl: (name, args) => name === "search_records"
        ? (args.model === "mail.message"
          ? searchResult(args.domain.length === 0 ? [{ id: 100 }] : [])
          : searchResult([{ id: 9, name: "FAC/X", state: "posted" }]))
        : { content: [{ type: "text", text: '{"record":{"id":9}}' }], isError: false },
    });
    await H.handleCall(be, { tool: "update_record", args: { model: "account.move", record_id: 9, values: { ref: "x" } } });
    const search = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    expect(JSON.stringify(search.args.fields)).toBe('["name","state"]');
  });
  it("capability: garde sans is_move_sent → dégradation ANNONCÉE + force_resend", async () => {
    // Serveur SANS is_move_sent → garde INAPPLICABLE, annoncée (pas un blocage menteur).
    const be = fakeBackend({ resourceText: "name:\n  Label: Name\nstate:\n" });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("n'expose PAS");
    expect(txt(r)).toContain("force_resend");
  });
  it("capability: métadonnées illisibles → champs souhaités conservés (fail-safe)", async () => {
    // Resource illisible → fail-safe : champs souhaités inchangés (historique).
    const be = fakeBackend({
      resourceThrows: true,
      callImpl: (name, args) => name === "search_records"
        ? (args.model === "mail.message" ? searchResult([{ id: 100 }]) : searchResult([{ id: 9, name: "F" }]))
        : { content: [{ type: "text", text: '{"record":{"id":9}}' }], isError: false },
    });
    await H.handleCall(be, { tool: "update_record", args: { model: "account.move", record_id: 9, values: { ref: "x" } } });
    const search = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    expect(search.args.fields).toContain("payment_state");
  });
});

describe("GARDE ANTI-DOUBLE-CRÉATION de facture d'abo", () => {
  const nowMonth = () => new Date().toISOString().slice(0, 7);

  // Abo déjà facturé CE MOIS-CI → generate_invoice BLOQUÉ avant le backend.
  const alreadyInvoicedThisMonth = async () => {
    const m = nowMonth();
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [10] }],
        "account.move": [{ id: 10, name: "FAC/2026/00004", state: "posted", invoice_date: `${m}-01`, create_date: `${m}-01 05:00:00`, amount_total: 39 }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    return { be, r };
  };

  it("création: abo déjà facturé ce mois → BLOQUÉ + force_create proposé", async () => {
    const { r } = await alreadyInvoicedThisMonth();
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("ANTI-DOUBLE-CRÉATION");
    expect(txt(r)).toContain("FAC/2026/00004");
    expect(txt(r)).toContain("force_create");
  });
  it("création: le generate_invoice n'a JAMAIS atteint le backend", async () => {
    const { be } = await alreadyInvoicedThisMonth();
    expect(be.calls.every((c) => c.name === "search_records")).toBe(true);
  });
  it("création: dernière facture le mois passé → exécuté", async () => {
    // Dernière facture = mois PASSÉ → facturation légitime, ça passe.
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [9] }],
        "account.move": [{ id: 9, name: "FAC/OLD", state: "posted", invoice_date: "2020-01-15", create_date: "2020-01-15 05:00:00", amount_total: 39 }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    expect(r.isError).toBeFalsy();
    expect(be.calls.some((c) => c.name === "call_model_method")).toBe(true);
  });
  it("création: facture annulée ce mois → ne compte pas, exécuté", async () => {
    // Facture ce mois mais ANNULÉE → ne compte pas, ça passe.
    const m = nowMonth();
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [11] }],
        "account.move": [{ id: 11, name: "FAC/CANCEL", state: "cancel", invoice_date: `${m}-01`, create_date: `${m}-01 05:00:00`, amount_total: 39 }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    expect(r.isError).toBeFalsy();
    expect(be.calls.some((c) => c.name === "call_model_method")).toBe(true);
  });
  it("création: force_create → exécuté + strippé des args transmis", async () => {
    // force_create:true → bypass + strippé.
    const m = nowMonth();
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [10] }],
        "account.move": [{ id: 10, name: "FAC/2026/00004", state: "posted", invoice_date: `${m}-01`, create_date: `${m}-01 05:00:00` }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]], force_create: true } });
    const call = be.calls.find((c) => c.name === "call_model_method");
    expect(r.isError).toBeFalsy();
    expect(call).toBeTruthy();
    expect("force_create" in call.args).toBe(false);
  });
  it("création: état invérifiable → BLOQUÉ (fail-closed)", async () => {
    // Vérification impossible → FAIL-CLOSED (c'est de l'argent).
    const be = fakeBackend({ callImpl: (name) => { if (name === "search_records") throw new Error("down"); return { content: [], isError: false }; } });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("BLOQUÉE");
  });
});

describe("SCAN MAIL : emails partis pendant l'appel", () => {
  // Un mail.message avec destinataires apparaît pendant l'appel → REMONTÉ.
  const postWithSilentMail = async () => {
    const be = bizBackend({
      byModel: { "account.move": [{ id: 9, name: "FAC/2026/00003", is_move_sent: true }] },
      mailScan: [{ id: 101, message_type: "comment", subject: "ACME Facture", email_from: "billing@acme.example", partner_ids: [16], model: "account.move", res_id: 9 }],
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_post", arguments: [[9]] } });
    return { be, r };
  };

  it("mail: envoi silencieux pendant l'appel → REMONTÉ avec destinataires", async () => {
    const { r } = await postWithSilentMail();
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toContain("MESSAGE(S) PARTI(S)");
    expect(txt(r)).toContain("ACME Facture");
  });
  it("mail: scan borné à la baseline (id > 100, destinataires seulement)", async () => {
    const { be } = await postWithSilentMail();
    const scan = be.calls.find((c) => c.name === "search_records" && c.args.model === "mail.message" && c.args.domain.length > 0);
    expect(JSON.stringify(scan.args.domain)).toBe('[["id",">",100],["partner_ids","!=",false]]');
  });
  it("mail: aucun message → « Aucun destinataire notifié » (certitude)", async () => {
    // Aucun message créé → certitude POSITIVE explicite.
    const be = bizBackend({ byModel: { "res.partner": [{ id: 16, display_name: "Alice" }] } });
    const r = await H.handleCall(be, { tool: "update_record", args: { model: "res.partner", record_id: 16, values: { city: "Metropolis" } } });
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toContain("Aucun destinataire notifié");
  });
});

describe("GARDE ANTI-DOUBLON d'envoi", () => {
  // Facture déjà envoyée → envoi BLOQUÉ, le backend ne reçoit JAMAIS le send.
  const alreadySent = async () => {
    const be = fakeBackend({ callImpl: () => searchResult([{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid", is_move_sent: true }]) });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    return { be, r };
  };

  it("garde: déjà envoyée → isError GARDE ANTI-DOUBLON", async () => {
    const { r } = await alreadySent();
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("GARDE ANTI-DOUBLON");
    expect(txt(r)).toContain("force_resend");
  });
  it("garde: le send n'a JAMAIS atteint le backend", async () => {
    const { be } = await alreadySent();
    expect(be.calls.every((c) => c.name === "search_records")).toBe(true);
  });
  it("garde: non envoyée → send exécuté + état réel relu", async () => {
    // Pas encore envoyée → l'envoi passe (garde + send + relecture voyant).
    const be = fakeBackend({
      callImpl: (name) => name === "search_records"
        ? searchResult([{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid", is_move_sent: false }])
        : { content: [{ type: "text", text: '{"success":true,"result":null}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    expect(r.isError).toBeFalsy();
    expect(be.calls.some((c) => c.name === "call_model_method")).toBe(true);
    expect(txt(r)).toContain("ÉTAT RÉEL");
  });

  // force_resend:true → bypass la garde ET est STRIPPÉ avant le backend.
  const forcedResend = async () => {
    const be = fakeBackend({
      callImpl: (name) => name === "search_records"
        ? searchResult([{ id: 9, is_move_sent: true }])
        : { content: [{ type: "text", text: '{"success":true,"result":null}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]], force_resend: true } });
    return { be, r, send: be.calls.find((c) => c.name === "call_model_method") };
  };

  it("garde: force_resend → renvoi autorisé", async () => {
    const { r, send } = await forcedResend();
    expect(r.isError).toBeFalsy();
    expect(send).toBeTruthy();
  });
  it("garde: force_resend strippé des args transmis", async () => {
    const { send } = await forcedResend();
    expect("force_resend" in send.args).toBe(false);
  });
  it("garde: relecture impossible → BLOQUÉ (fail-closed)", async () => {
    // Vérification impossible → FAIL-CLOSED : envoi bloqué.
    const be = fakeBackend({ callImpl: (name) => { if (name === "search_records") throw new Error("down"); return { content: [], isError: false }; } });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "send_and_print", arguments: [[9]] } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("BLOQUÉ");
    expect(be.calls.every((c) => c.name === "search_records")).toBe(true);
  });
});

describe("CANARY : blocage de garde → ping NTFY (spy injecté)", () => {
  // Le spy accumule les pings ; chaque test rejoue la séquence dont il a besoin
  // (l'assertion n°3 porte sur l'ABSENCE de ping supplémentaire après les 2 gardes).
  const spy = () => {
    const pings = [];
    const HC = makeHandlers({ ...validate, ...fields, ...readback, fireCanary: (_h, title, msg) => { pings.push({ title, msg }); return true; } });
    return { pings, HC };
  };
  // 1. Garde anti-doublon déclenchée → 1 ping avec le message de blocage.
  const step1 = async (HC) => {
    const be = fakeBackend({ callImpl: () => searchResult([{ id: 9, name: "FAC/2026/00003", is_move_sent: true }]) });
    return HC.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
  };
  // 2. Garde anti-double-création (fail-closed relecture KO) → ping aussi.
  const step2 = async (HC) => {
    const be2 = fakeBackend({ callImpl: (name) => { if (name === "search_records") throw new Error("down"); return { content: [], isError: false }; } });
    return HC.handleCall(be2, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
  };

  it("canary: garde anti-doublon → ping NTFY (titre ASCII + message du blocage)", async () => {
    const { pings, HC } = spy();
    const r = await step1(HC);
    expect(r.isError).toBe(true);
    expect(pings).toHaveLength(1);
    expect(pings[0].title).toBe("Garde Odoo MCP declenchee");
    expect(pings[0].msg).toContain("ANTI-DOUBLON");
  });
  it("canary: fail-closed anti-double-création → ping aussi", async () => {
    const { pings, HC } = spy();
    await step1(HC);
    await step2(HC);
    expect(pings).toHaveLength(2);
    expect(pings[1].msg).toContain("ANTI-DOUBLE-CRÉATION");
  });
  it("canary: lecture saine + erreur de validation → zéro ping", async () => {
    // 3. Appel sain + erreur de validation → JAMAIS de ping (réservé aux gardes).
    const { pings, HC } = spy();
    await step1(HC);
    await step2(HC);
    await HC.handleCall(fakeBackend(), { tool: "search_records", args: { model: "res.partner" } });
    await HC.handleCall(fakeBackend(), { tool: "" });
    expect(pings).toHaveLength(2);
  });
  it("canary: fireCanary absent → blocage intact (canary jamais une dépendance)", async () => {
    // fireCanary ABSENT des deps → les gardes bloquent quand même (noop, pas de crash).
    const be = fakeBackend({ callImpl: () => searchResult([{ id: 9, is_move_sent: true }]) });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "send_and_print", arguments: [[9]] } });
    expect(r.isError).toBe(true);
    expect(txt(r)).toContain("ANTI-DOUBLON");
  });
});
