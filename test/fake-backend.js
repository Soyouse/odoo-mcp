#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// test/fake-backend.js — Faux backend MCP (stdio, newline-delimited JSON-RPC).
// ═══════════════════════════════════════════════════════════════════════
//
// Sert à TESTER proxy.js sans toucher au vrai Odoo. Le proxy le lance via
// l'override ODOO_BACKEND_CMD=["node", "<ce fichier>"]. Scénario via FAKE_SCENARIO :
//   ok           : initialize OK, tools/list = 2 outils, tools/call = écho content.
//   error_result : tools/call → réponse JSON-RPC error (erreur TRANSPORT).
//   field_error  : tools/call → résultat isError « Invalid field » (= chemin RÉEL
//                  du backend Odoo, PAS une erreur JSON-RPC) ; fields_get renvoie
//                  la liste des champs → prouve l'enrichissement T-04 bout-en-bout.
//   crash_on_call: tools/call → process.exit(1) (mort en cours d'appel).
//   init_fail    : exit(1) immédiat (backend mort au boot).
//
// ⚠️ Pur test : NE JAMAIS importer ce fichier en prod. Newline-delimited JSON.

import readline from "readline";

const SCENARIO = process.env.FAKE_SCENARIO || "ok";

if (SCENARIO === "init_fail") {
  // Backend qui meurt au démarrage (réseau down / mauvais creds simulés).
  process.stderr.write("fake-backend: simulating boot crash\n");
  process.exit(1);
}

const TOOLS = [
  {
    name: "search_records",
    description: "Search records (fake).",
    inputSchema: { type: "object", properties: { model: { type: "string", description: "model" } }, required: ["model"] },
  },
  { name: "get_record", description: "Get one record (fake).", inputSchema: { type: "object", properties: {} } },
  { name: "update_record", description: "Update one record (fake).", inputSchema: { type: "object", properties: {} } },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  // Notifications (pas d'id) : on ignore.
  if (id == null) return;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-odoo", version: "0.0.1" } } });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  // resources/read : découverte de champs. ⚠️ MESURÉ sur le vrai backend 0.6.0 —
  // format TEXTE humain (pas JSON) : chaque champ = `nom:` en colonne 0 + lignes
  // indentées. On reproduit FIDÈLEMENT pour que le test prouve le vrai parsing.
  if (method === "resources/read") {
    const text =
      "============================================================\n" +
      "Field Definitions: res.partner\nTotal fields: 10\n\n" +
      "CHAR Fields (10):\n------------------------------\n\n" +
      "name:\n  Label: Name\n  Required: True\n\n" +
      "email:\n  Label: Email\n  Required: False\n\n" +
      "phone:\n  Label: Phone\n  Required: False\n\n" +
      "state:\n  Label: Status\n\npayment_state:\n  Label: Payment Status\n\n" +
      "is_move_sent:\n  Label: Sent\n\namount_total:\n  Label: Total\n\n" +
      "partner_id:\n  Label: Partner\n\ndisplay_name:\n  Label: Display Name\n\n" +
      "write_date:\n  Label: Last Updated\n";
    send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params?.uri, mimeType: "text/plain", text }] } });
    return;
  }

  if (method === "tools/call") {
    if (SCENARIO === "crash_on_call") { process.exit(1); }
    if (SCENARIO === "error_result") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "fake backend error" } });
      return;
    }
    const toolName = params?.name;
    if (SCENARIO === "field_error") {
      // Chemin RÉEL d'une erreur d'outil Odoo : résultat isError, PAS erreur JSON-RPC.
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error executing tool search_records: Invalid field 'naem' in request" }], isError: true } });
      return;
    }
    // ok — update_record : réponse RÉALISTE du backend 0.6.0 (record minimal),
    // déclenche la relecture voyant côté proxy.
    if (toolName === "update_record") {
      const rid = params?.arguments?.record_id;
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, record: { id: rid, display_name: "Fake" }, message: `Successfully updated record with ID ${rid}` }) }] } });
      return;
    }
    // ok — search_records mail.message : snapshot (domain vide) → dernier id 100 ;
    // scan (domain id>100) → un email « parti » réaliste (relecture mail voyante).
    const dom = params?.arguments?.domain;
    if (toolName === "search_records" && params?.arguments?.model === "mail.message") {
      const records = (dom || []).length === 0
        ? [{ id: 100 }]
        : [{ id: 101, message_type: "comment", subject: "Fake Facture", email_from: "billing@acme.example", partner_ids: [16], model: "account.move", res_id: 9 }];
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ records, total: records.length }) }] } });
      return;
    }
    // ok — search_records AVEC domain [["id","in",[...]]] : relecture voyante →
    // renvoie des records d'état réalistes pour ces ids.
    if (toolName === "search_records" && Array.isArray(dom) && dom[0]?.[0] === "id" && dom[0]?.[1] === "in") {
      const records = (dom[0][2] || []).map((rid) => ({ id: rid, name: "FAC/TEST", state: "posted", payment_state: "not_paid", is_move_sent: false }));
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ records, total: records.length }) }] } });
      return;
    }
    // ok : renvoie un content text façon Odoo (enveloppe MCP côté proxy).
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ called: toolName, args: params?.arguments || {}, id: 42 }) }] } });
    return;
  }

  // Méthode inconnue → erreur JSON-RPC standard.
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
});
