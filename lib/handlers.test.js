// Tests lib/handlers.js — logique métier avec un BACKEND FACTICE (zéro spawn).
// Prouve : formatage discover, validation précoce, routage isError, enrichissement
// champs (resource), et fail-safe transport. Deps réelles injectées (validate+fields).
import { makeHandlers } from "./handlers.js";
import * as validate from "./validate.js";
import * as fields from "./fields.js";
import * as readback from "./readback.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

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

async function main() {
  console.log("lib/handlers.test.js\n");

  // ── handleDiscover ──
  {
    const r = await H.handleDiscover(fakeBackend());
    ok("discover formate les outils (## search_records)", txt(r).includes("## search_records") && txt(r).includes("Odoo CRM tools (1)"));
    ok("discover marque le param requis avec *", txt(r).includes("model*"));
  }
  {
    const r = await H.handleDiscover(fakeBackend({ getToolsThrows: true }));
    ok("discover backend down → isError + proxy vivant (pas de throw)", r.isError === true && txt(r).includes("backend unavailable"));
  }

  // ── handleCall : validation précoce ──
  {
    ok("call sans tool → erreur immédiate isError", (await H.handleCall(fakeBackend(), { tool: "" })).isError === true);
    ok("call args=array → 'must be an object'", txt(await H.handleCall(fakeBackend(), { tool: "search_records", args: [1] })).includes("must be an object"));
    const unk = await H.handleCall(fakeBackend({ known: ["search_records", "get_record"] }), { tool: "search_record", args: {} });
    ok("call nom inconnu (cache chaud) → suggestion", unk.isError === true && txt(unk).includes("search_records"));
  }

  // ── handleCall : succès ──
  {
    const r = await H.handleCall(fakeBackend(), { tool: "search_records", args: { model: "res.partner" } });
    ok("call OK → content renvoyé sans isError", !r.isError && txt(r).includes("id"));
  }

  // ── handleCall : erreur d'outil isError + enrichissement via resource ──
  {
    const be = fakeBackend({ callResult: { content: [{ type: "text", text: "Invalid field 'naem' in request" }], isError: true } });
    const r = await H.handleCall(be, { tool: "search_records", args: { model: "res.partner", fields: ["naem"] } });
    ok("Invalid field (isError) → enrichi (Champs valides + name)", r.isError === true && txt(r).includes("Champs valides") && txt(r).includes("name"));
  }
  {
    // isError SANS model → pas d'enrichissement → message propagé + isError gardé
    const be = fakeBackend({ callResult: { content: [{ type: "text", text: "Invalid field 'naem' in request" }], isError: true } });
    const r = await H.handleCall(be, { tool: "search_records", args: {} });
    ok("isError sans model → propagé tel quel + isError", r.isError === true && txt(r).includes("Invalid field"));
  }
  {
    // enrichissement demandé mais resource KO → fail-safe : message d'origine
    const be = fakeBackend({ callResult: { content: [{ type: "text", text: "Invalid field 'naem'" }], isError: true }, resourceThrows: true });
    const r = await H.handleCall(be, { tool: "search_records", args: { model: "res.partner" } });
    ok("resource KO → fail-safe, isError + message d'origine", r.isError === true && txt(r).includes("Invalid field"));
  }

  // ── handleCall : exception TRANSPORT (backend throw) ──
  {
    const r = await H.handleCall(fakeBackend({ callThrows: "Backend not running" }), { tool: "search_records", args: { model: "res.partner" } });
    ok("transport throw → isError 'Error:' (jamais de throw remonté)", r.isError === true && txt(r).includes("Backend not running"));
  }
  {
    // transport throw AVEC un message Invalid field + model → enrichi aussi
    const r = await H.handleCall(fakeBackend({ callThrows: "Invalid field 'naem'" }), { tool: "search_records", args: { model: "res.partner" } });
    ok("transport throw 'Invalid field' + model → enrichi", r.isError === true && txt(r).includes("Champs valides"));
  }

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

  // ── MCP VOYANT : relecture post-écriture ──
  {
    // update_record OK → une relecture search_records est appendue au résultat.
    const be = bizBackend({
      byModel: { "account.move": [{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid", is_move_sent: true }] },
      writeResult: { content: [{ type: "text", text: '{"success":true,"record":{"id":9}}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "update_record", args: { model: "account.move", record_id: 9, values: { ref: "x" } } });
    const search = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    ok("voyant: update → relecture appendue (ÉTAT RÉEL, JSON récoltable)", !r.isError && txt(r).includes("ÉTAT RÉEL") && txt(r).includes('"is_move_sent":true') && txt(r).includes('"id":9'));
    ok("voyant: relecture = search_records id in [9] + champs stables", search && JSON.stringify(search.args.domain) === '[["id","in",[9]]]' && search.args.fields.includes("payment_state"));
  }
  {
    // call_model_method retour null (cas réel du doublon) → relecture + cascade abo→factures.
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 3, display_name: "SUB00007", invoice_ids: [9] }],
        "account.move": [{ id: 9, name: "FAC/2026/00003", is_move_sent: true }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[3]] } });
    const cascade = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    ok("voyant: méthode muette (null) → état réel quand même relu", !r.isError && txt(r).includes("ÉTAT RÉEL") && txt(r).includes("SUB00007"));
    ok("voyant: cascade abo → relecture des factures liées", cascade && JSON.stringify(cascade.args.domain) === '[["id","in",[9]]]' && txt(r).includes("FAC/2026/00003"));
    ok("piège: generate_invoice → PIÈGE CONNU appendu (agent sans skill prévenu)", txt(r).includes("PIÈGE CONNU") && txt(r).includes("invoice_send"));
  }
  {
    // Relecture KO → l'écriture reste un SUCCÈS + warning explicite (fail-safe).
    const be = fakeBackend({
      callImpl: (name) => name === "search_records"
        ? { content: [{ type: "text", text: "boom" }], isError: true }
        : { content: [{ type: "text", text: '{"record":{"id":9}}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "create_record", args: { model: "res.partner", values: { name: "X" } } });
    ok("voyant: relecture KO → succès conservé + warning 'vérifie'", !r.isError && txt(r).includes("relecture de vérification KO"));
    ok("voyant: snapshot mail KO → l'incertitude est DITE (pas de faux 'aucun email')", txt(r).includes("emails IMPOSSIBLE"));
  }
  {
    // Outil de LECTURE → aucune relecture ni scan mail (un seul appel backend).
    const be = fakeBackend();
    await H.handleCall(be, { tool: "search_records", args: { model: "res.partner" } });
    ok("voyant: outil lecture → un seul appel backend", be.calls.length === 1);
  }

  // ── CAPABILITY DETECTION : champs souhaités ∩ champs réels ──
  {
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
    ok("capability: champs relus = souhaités ∩ réels (payment_state absent → omis)",
      search && JSON.stringify(search.args.fields) === '["name","state"]');
  }
  {
    // Serveur SANS is_move_sent → garde INAPPLICABLE, annoncée (pas un blocage menteur).
    const be = fakeBackend({ resourceText: "name:\n  Label: Name\nstate:\n" });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    ok("capability: garde sans is_move_sent → dégradation ANNONCÉE + force_resend",
      r.isError === true && txt(r).includes("n'expose PAS") && txt(r).includes("force_resend"));
  }
  {
    // Resource illisible → fail-safe : champs souhaités inchangés (historique).
    const be = fakeBackend({
      resourceThrows: true,
      callImpl: (name, args) => name === "search_records"
        ? (args.model === "mail.message" ? searchResult([{ id: 100 }]) : searchResult([{ id: 9, name: "F" }]))
        : { content: [{ type: "text", text: '{"record":{"id":9}}' }], isError: false },
    });
    await H.handleCall(be, { tool: "update_record", args: { model: "account.move", record_id: 9, values: { ref: "x" } } });
    const search = be.calls.find((c) => c.name === "search_records" && c.args.model === "account.move");
    ok("capability: métadonnées illisibles → champs souhaités conservés (fail-safe)",
      search && search.args.fields.includes("payment_state"));
  }

  // ── GARDE ANTI-DOUBLE-CRÉATION de facture d'abo ──
  const nowMonth = new Date().toISOString().slice(0, 7);
  {
    // Abo déjà facturé CE MOIS-CI → generate_invoice BLOQUÉ avant le backend.
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [10] }],
        "account.move": [{ id: 10, name: "FAC/2026/00004", state: "posted", invoice_date: `${nowMonth}-01`, create_date: `${nowMonth}-01 05:00:00`, amount_total: 39 }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    ok("création: abo déjà facturé ce mois → BLOQUÉ + force_create proposé",
      r.isError === true && txt(r).includes("ANTI-DOUBLE-CRÉATION") && txt(r).includes("FAC/2026/00004") && txt(r).includes("force_create"));
    ok("création: le generate_invoice n'a JAMAIS atteint le backend", be.calls.every((c) => c.name === "search_records"));
  }
  {
    // Dernière facture = mois PASSÉ → facturation légitime, ça passe.
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [9] }],
        "account.move": [{ id: 9, name: "FAC/OLD", state: "posted", invoice_date: "2020-01-15", create_date: "2020-01-15 05:00:00", amount_total: 39 }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    ok("création: dernière facture le mois passé → exécuté", !r.isError && be.calls.some((c) => c.name === "call_model_method"));
  }
  {
    // Facture ce mois mais ANNULÉE → ne compte pas, ça passe.
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [11] }],
        "account.move": [{ id: 11, name: "FAC/CANCEL", state: "cancel", invoice_date: `${nowMonth}-01`, create_date: `${nowMonth}-01 05:00:00`, amount_total: 39 }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    ok("création: facture annulée ce mois → ne compte pas, exécuté", !r.isError && be.calls.some((c) => c.name === "call_model_method"));
  }
  {
    // force_create:true → bypass + strippé.
    const be = bizBackend({
      byModel: {
        "sale.subscription": [{ id: 7, display_name: "SUB00007", invoice_ids: [10] }],
        "account.move": [{ id: 10, name: "FAC/2026/00004", state: "posted", invoice_date: `${nowMonth}-01`, create_date: `${nowMonth}-01 05:00:00` }],
      },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]], force_create: true } });
    const call = be.calls.find((c) => c.name === "call_model_method");
    ok("création: force_create → exécuté + strippé des args transmis", !r.isError && call && !("force_create" in call.args));
  }
  {
    // Vérification impossible → FAIL-CLOSED (c'est de l'argent).
    const be = fakeBackend({ callImpl: (name) => { if (name === "search_records") throw new Error("down"); return { content: [], isError: false }; } });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    ok("création: état invérifiable → BLOQUÉ (fail-closed)", r.isError === true && txt(r).includes("BLOQUÉE"));
  }

  // ── SCAN MAIL : emails partis pendant l'appel ──
  {
    // Un mail.message avec destinataires apparaît pendant l'appel → REMONTÉ.
    const be = bizBackend({
      byModel: { "account.move": [{ id: 9, name: "FAC/2026/00003", is_move_sent: true }] },
      mailScan: [{ id: 101, message_type: "comment", subject: "ACME Facture", email_from: "billing@acme.example", partner_ids: [16], model: "account.move", res_id: 9 }],
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_post", arguments: [[9]] } });
    const scan = be.calls.find((c) => c.name === "search_records" && c.args.model === "mail.message" && c.args.domain.length > 0);
    ok("mail: envoi silencieux pendant l'appel → REMONTÉ avec destinataires", !r.isError && txt(r).includes("MESSAGE(S) PARTI(S)") && txt(r).includes("ACME Facture"));
    ok("mail: scan borné à la baseline (id > 100, destinataires seulement)", scan && JSON.stringify(scan.args.domain) === '[["id",">",100],["partner_ids","!=",false]]');
  }
  {
    // Aucun message créé → certitude POSITIVE explicite.
    const be = bizBackend({ byModel: { "res.partner": [{ id: 16, display_name: "Alice" }] } });
    const r = await H.handleCall(be, { tool: "update_record", args: { model: "res.partner", record_id: 16, values: { city: "Metropolis" } } });
    ok("mail: aucun message → « Aucun destinataire notifié » (certitude)", !r.isError && txt(r).includes("Aucun destinataire notifié"));
  }

  // ── GARDE ANTI-DOUBLON d'envoi ──
  {
    // Facture déjà envoyée → envoi BLOQUÉ, le backend ne reçoit JAMAIS le send.
    const be = fakeBackend({ callImpl: () => searchResult([{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid", is_move_sent: true }]) });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    ok("garde: déjà envoyée → isError GARDE ANTI-DOUBLON", r.isError === true && txt(r).includes("GARDE ANTI-DOUBLON") && txt(r).includes("force_resend"));
    ok("garde: le send n'a JAMAIS atteint le backend", be.calls.every((c) => c.name === "search_records"));
  }
  {
    // Pas encore envoyée → l'envoi passe (garde + send + relecture voyant).
    const be = fakeBackend({
      callImpl: (name) => name === "search_records"
        ? searchResult([{ id: 9, name: "FAC/2026/00003", state: "posted", payment_state: "not_paid", is_move_sent: false }])
        : { content: [{ type: "text", text: '{"success":true,"result":null}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    ok("garde: non envoyée → send exécuté + état réel relu", !r.isError && be.calls.some((c) => c.name === "call_model_method") && txt(r).includes("ÉTAT RÉEL"));
  }
  {
    // force_resend:true → bypass la garde ET est STRIPPÉ avant le backend.
    const be = fakeBackend({
      callImpl: (name) => name === "search_records"
        ? searchResult([{ id: 9, is_move_sent: true }])
        : { content: [{ type: "text", text: '{"success":true,"result":null}' }], isError: false },
    });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]], force_resend: true } });
    const send = be.calls.find((c) => c.name === "call_model_method");
    ok("garde: force_resend → renvoi autorisé", !r.isError && !!send);
    ok("garde: force_resend strippé des args transmis", send && !("force_resend" in send.args));
  }
  {
    // Vérification impossible → FAIL-CLOSED : envoi bloqué.
    const be = fakeBackend({ callImpl: (name) => { if (name === "search_records") throw new Error("down"); return { content: [], isError: false }; } });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "send_and_print", arguments: [[9]] } });
    ok("garde: relecture impossible → BLOQUÉ (fail-closed)", r.isError === true && txt(r).includes("BLOQUÉ") && be.calls.every((c) => c.name === "search_records"));
  }

  // ── CANARY : blocage de garde → ping NTFY (spy injecté) ──
  {
    const pings = [];
    const HC = makeHandlers({ ...validate, ...fields, ...readback, fireCanary: (_h, title, msg) => { pings.push({ title, msg }); return true; } });
    // 1. Garde anti-doublon déclenchée → 1 ping avec le message de blocage.
    const be = fakeBackend({ callImpl: () => searchResult([{ id: 9, name: "FAC/2026/00003", is_move_sent: true }]) });
    const r = await HC.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "action_send_and_print", arguments: [[9]] } });
    ok("canary: garde anti-doublon → ping NTFY (titre ASCII + message du blocage)",
      r.isError === true && pings.length === 1 && pings[0].title === "Garde Odoo MCP declenchee" && pings[0].msg.includes("ANTI-DOUBLON"));
    // 2. Garde anti-double-création (fail-closed relecture KO) → ping aussi.
    const be2 = fakeBackend({ callImpl: (name) => { if (name === "search_records") throw new Error("down"); return { content: [], isError: false }; } });
    await HC.handleCall(be2, { tool: "call_model_method", args: { model: "sale.subscription", method: "generate_invoice", arguments: [[7]] } });
    ok("canary: fail-closed anti-double-création → ping aussi", pings.length === 2 && pings[1].msg.includes("ANTI-DOUBLE-CRÉATION"));
    // 3. Appel sain + erreur de validation → JAMAIS de ping (réservé aux gardes).
    await HC.handleCall(fakeBackend(), { tool: "search_records", args: { model: "res.partner" } });
    await HC.handleCall(fakeBackend(), { tool: "" });
    ok("canary: lecture saine + erreur de validation → zéro ping", pings.length === 2);
  }
  {
    // fireCanary ABSENT des deps → les gardes bloquent quand même (noop, pas de crash).
    const be = fakeBackend({ callImpl: () => searchResult([{ id: 9, is_move_sent: true }]) });
    const r = await H.handleCall(be, { tool: "call_model_method", args: { model: "account.move", method: "send_and_print", arguments: [[9]] } });
    ok("canary: fireCanary absent → blocage intact (canary jamais une dépendance)", r.isError === true && txt(r).includes("ANTI-DOUBLON"));
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
