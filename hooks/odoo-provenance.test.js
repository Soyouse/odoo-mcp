// ═══════════════════════════════════════════════════════════════════════
// Tests odoo-provenance.cjs — runner vitest (le HOOK reste en CJS : il est
// spawné par node à chaque appel d'outil, on ne touche PAS son format).
//
// Spawn le hook en child process, feed stdin JSON (format Claude Code hooks),
// parse stdout JSON, assert le résultat. Chaque cas utilise un session_id
// JETABLE isolé → state/odoo-seen-<id>.json nettoyé en fin de run.
//
// Couvre : RÉGRESSION du double-échappement de l'enveloppe MCP (cause n°1),
// gate allow/deny, non-récolte des erreurs, cas spécial get_record (input id),
// create_record record.id, outils non gatés.
//
// ⚠️ Ce fichier SPAWNE des process (spawnSync) → `testTimeout: 30000`
//    (vitest.config.js) : le défaut 5 s de vitest est calé sur des tests
//    EN MÉMOIRE, pas sur ~1,5 s de démarrage node par appel.
// ═══════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, "odoo-provenance.cjs");
const STATE_DIR = path.join(__dirname, "state");

const sessions = new Set(); // session_ids à nettoyer

function run(payload) {
  if (payload.session_id) sessions.add(payload.session_id);
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  return { stdout: (r.stdout || "").trim(), status: r.status };
}

// Enveloppe MCP réelle (mesurée 2026-06-10) : array de blocs text dont le
// `text` est une CHAÎNE JSON. C'est CE format que le hook reçoit en prod.
function mcpWrap(obj) {
  return [{ type: "text", text: JSON.stringify(obj, null, 2) }];
}

function postSearch(sessionId, responseObj) {
  return run({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__odoo__odoo_call",
    session_id: sessionId,
    tool_input: { tool: "search_records", args: { model: "product.template" } },
    tool_response: mcpWrap(responseObj),
  });
}

function postGet(sessionId, recordId, responseObj) {
  return run({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__odoo__odoo_call",
    session_id: sessionId,
    tool_input: { tool: "get_record", args: { model: "product.template", record_id: recordId } },
    tool_response: mcpWrap(responseObj),
  });
}

function postCreate(sessionId, responseObj) {
  return run({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__odoo__odoo_call",
    session_id: sessionId,
    tool_input: { tool: "create_record", args: { model: "product.template" } },
    tool_response: mcpWrap(responseObj),
  });
}

function preMutate(sessionId, op, recordId) {
  return run({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__odoo__odoo_call",
    session_id: sessionId,
    tool_input: { tool: op, args: { model: "product.template", record_id: recordId } },
  });
}

const isDeny = (res) => res.stdout.includes('"permissionDecision": "deny"') || res.stdout.includes('"permissionDecision":"deny"');

// ── Cleanup state jetable ──
afterAll(() => {
  for (const s of sessions) {
    const safe = String(s).replace(/[^a-zA-Z0-9_-]/g, "");
    const f = path.join(STATE_DIR, `odoo-seen-${safe}.json`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* état jetable */ }
  }
});

// ── RÉGRESSION : enveloppe MCP double-échappée → l'id DOIT être récolté ──
// Avant le fix : extractIds(JSON.stringify(wrapper)) ne matchait jamais "id":N
// (quotes échappées \"id\") → search ne récoltait rien → mutation refusée à tort.
describe("récolte depuis l'enveloppe MCP (régression double-échappement)", () => {
  it("search_records (wrapper MCP) récolte id 5 → update_record 5 ALLOW", () => {
    const s = "test-regress-1a";
    postSearch(s, { records: [{ id: 5, name: "Logo" }, { id: 28, name: "Flyer" }], total: 2 });
    expect(isDeny(preMutate(s, "update_record", 5))).toBe(false);
  });
  it("search_records (wrapper MCP) récolte id 28 → update_record 28 ALLOW", () => {
    const s = "test-regress-1b";
    postSearch(s, { records: [{ id: 5, name: "Logo" }, { id: 28, name: "Flyer" }], total: 2 });
    expect(isDeny(preMutate(s, "update_record", 28))).toBe(false);
  });
  it("create_record (wrapper MCP) récolte record.id 42 → update_record 42 ALLOW", () => {
    const s = "test-create-6";
    postCreate(s, { record: { id: 42, name: "Nouveau" } });
    expect(isDeny(preMutate(s, "update_record", 42))).toBe(false);
  });
});

describe("gate provenance : id jamais vu → DENY", () => {
  it("update_record sur id 999 jamais récolté → DENY", () => {
    const s = "test-deny-2a";
    postSearch(s, { records: [{ id: 5, name: "Logo" }], total: 1 });
    expect(isDeny(preMutate(s, "update_record", 999))).toBe(true);
  });
  it("delete_record sur id 999 jamais récolté → DENY", () => {
    const s = "test-deny-2b";
    postSearch(s, { records: [{ id: 5, name: "Logo" }], total: 1 });
    expect(isDeny(preMutate(s, "delete_record", 999))).toBe(true);
  });
  it("search en erreur → update_record refusé (rien récolté)", () => {
    // Une réponse search en erreur ne porte pas de "id":N → rien récolté.
    const s = "test-error-3";
    postSearch(s, { error: "Record does not exist", records: [] });
    expect(isDeny(preMutate(s, "update_record", 5))).toBe(true);
  });
});

describe("get_record : l'id d'ENTRÉE n'est récolté qu'en cas de succès", () => {
  it("get_record succès → update_record 7 ALLOW", () => {
    const s = "test-getok-4";
    postGet(s, 7, { id: 7, name: "Truc", list_price: 597 });
    expect(isDeny(preMutate(s, "update_record", 7))).toBe(false);
  });
  it("get_record en erreur → update_record 404 DENY (pas de whitelist d'un id inexistant)", () => {
    const s = "test-geterr-5";
    postGet(s, 404, { error: "Record not found" });
    expect(isDeny(preMutate(s, "update_record", 404))).toBe(true);
  });
});

// ── outils non gatés jamais bloqués (surface RÉELLE backend 0.6.0) ──
describe("outils non gatés → jamais bloqués", () => {
  it("search_records jamais gaté (PreToolUse) → ALLOW", () => {
    expect(isDeny(run({
      hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: "test-nogate-7",
      tool_input: { tool: "search_records", args: { model: "res.partner" } },
    }))).toBe(false);
  });
  it("aggregate_records → ALLOW (non mutant, pas de record_id)", () => {
    // aggregate_records = lecture agrégée, aucun record_id → jamais gaté
    expect(isDeny(run({
      hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: "test-nogate-7",
      tool_input: { tool: "aggregate_records", args: { model: "sale.order", groupby: ["state"] } },
    }))).toBe(false);
  });
  it("create_record → ALLOW (pas d'id en entrée)", () => {
    // create_record = pas de record_id en entrée → jamais gaté
    expect(isDeny(run({
      hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: "test-nogate-7",
      tool_input: { tool: "create_record", args: { model: "res.partner", values: { name: "X" } } },
    }))).toBe(false);
  });
});

// ── isolation par session : id vu en session A invisible en session B ──
describe("isolation par session", () => {
  it("id 88 vu en session A → ALLOW en A", () => {
    postSearch("test-iso-A", { records: [{ id: 88, name: "X" }], total: 1 });
    expect(isDeny(preMutate("test-iso-A", "update_record", 88))).toBe(false);
  });
  it("id 88 invisible en session B → DENY en B", () => {
    postSearch("test-iso-A", { records: [{ id: 88, name: "X" }], total: 1 });
    expect(isDeny(preMutate("test-iso-B", "update_record", 88))).toBe(true);
  });
});

// ── post_message MUTE par record_id → même gate que update/delete ──
// Poster sur un id halluciné = écrire dans le chatter du mauvais contact.
describe("post_message = mutation gatée", () => {
  it("post_message sur id 16 (vu) → ALLOW", () => {
    const s = "test-postmsg-9a";
    postSearch(s, { records: [{ id: 16, name: "Alice Martin" }], total: 1 });
    expect(isDeny(preMutate(s, "post_message", 16))).toBe(false);
  });
  it("post_message sur id 999 (jamais vu) → DENY", () => {
    const s = "test-postmsg-9b";
    postSearch(s, { records: [{ id: 16, name: "Alice Martin" }], total: 1 });
    expect(isDeny(preMutate(s, "post_message", 999))).toBe(true);
  });
});

// ── call_model_method : ids dans arguments[0] (recordset) ──
// Active via ODOO_MCP_ENABLE_METHOD_CALLS. Gate sur la provenance, comme les autres.
describe("call_model_method : gate sur le recordset arguments[0]", () => {
  const callMethod = (sid, recordset) => run({
    hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: sid,
    tool_input: { tool: "call_model_method", args: { model: "account.move", method: "action_post", arguments: recordset } },
  });

  it("call_model_method action_post sur [[16]] (vu) → ALLOW", () => {
    const s = "test-cmm-10a";
    postSearch(s, { records: [{ id: 16, name: "Alice Martin" }], total: 1 });
    expect(isDeny(callMethod(s, [[16]]))).toBe(false);
  });
  it("call_model_method action_post sur [[999]] (jamais vu) → DENY", () => {
    const s = "test-cmm-10b";
    postSearch(s, { records: [{ id: 16, name: "Alice Martin" }], total: 1 });
    expect(isDeny(callMethod(s, [[999]]))).toBe(true);
  });
  it("call_model_method unlink sur [[999]] (jamais vu) → DENY", () => {
    expect(isDeny(run({
      hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: "test-cmm-10c",
      tool_input: { tool: "call_model_method", args: { model: "account.move", method: "unlink", arguments: [[999]] } },
    }))).toBe(true);
  });
  it("call_model_method arguments string-JSON [[999]] (jamais vu) → DENY", () => {
    // arguments[0] en STRING JSON (le backend accepte les deux) → doit être parsé.
    expect(isDeny(run({
      hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: "test-cmm-10d",
      tool_input: { tool: "call_model_method", args: { model: "account.move", method: "action_post", arguments: "[[999]]" } },
    }))).toBe(true);
  });
});

// ── call_model_method SANS recordset → FAIL-OPEN (zéro faux positif) ──
// arguments[0] = domain (search), vals dict (create), ou absent → pas un recordset
// → ne JAMAIS bloquer (sinon on casse des lectures/créations légitimes).
describe("call_model_method sans recordset → fail-open", () => {
  const pre = (a) => run({
    hook_event_name: "PreToolUse", tool_name: "mcp__odoo__odoo_call", session_id: "test-cmm-failopen-11",
    tool_input: { tool: "call_model_method", args: { model: "sale.order", method: "X", arguments: a } },
  });

  it('arguments[0] = domain [["id","=",5]] (lecture) → ALLOW (pas un recordset)', () => {
    expect(isDeny(pre([[["id", "=", 5]]]))).toBe(false);
  });
  it("arguments[0] = vals dict (create) → ALLOW", () => {
    expect(isDeny(pre([{ name: "X" }]))).toBe(false);
  });
  it("arguments absent → ALLOW (méthode statique, pas d'id)", () => {
    expect(isDeny(pre(undefined))).toBe(false);
  });
  it("arguments = [] → ALLOW", () => {
    expect(isDeny(pre([]))).toBe(false);
  });
});

// ── call_model_method récolte l'id retourné (chaînage create→mutate) ──
// Une méthode qui crée/retourne un record ("id": N) doit whitelister cet id.
describe("call_model_method récolte l'id retourné", () => {
  it("id 55 retourné par call_model_method → update_record 55 ALLOW", () => {
    const s = "test-cmm-harvest-12";
    run({
      hook_event_name: "PostToolUse", tool_name: "mcp__odoo__odoo_call", session_id: s,
      tool_input: { tool: "call_model_method", args: { model: "sale.advance.payment.inv", method: "create", arguments: [{}] } },
      tool_response: mcpWrap({ success: true, result: { id: 55 } }),
    });
    expect(isDeny(preMutate(s, "update_record", 55))).toBe(false);
  });
});
