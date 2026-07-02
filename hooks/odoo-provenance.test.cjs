#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// Tests odoo-provenance.js — Harness Node natif (zéro dep).
//
// Spawn le hook en child process, feed stdin JSON (format Claude Code hooks),
// parse stdout JSON, assert le résultat. Chaque cas utilise un session_id
// JETABLE isolé → state/odoo-seen-<id>.json nettoyé en fin de run.
//
// Couvre : RÉGRESSION du double-échappement de l'enveloppe MCP (cause n°1),
// gate allow/deny, non-récolte des erreurs, cas spécial get_record (input id),
// create_record record.id, outils non gatés.
//
// Run : `node odoo-provenance.test.js` depuis ~/.claude/hooks/
// Exit 0 si tous tests pass. Exit 1 si au moins un fail.
// ═══════════════════════════════════════════════════════════════════════

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOOK = path.join(__dirname, 'odoo-provenance.cjs');
const STATE_DIR = path.join(__dirname, 'state');

let pass = 0, fail = 0;
const sessions = new Set(); // session_ids à nettoyer

function run(payload) {
  if (payload.session_id) sessions.add(payload.session_id);
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { stdout: (r.stdout || '').trim(), status: r.status };
}

function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// Enveloppe MCP réelle (mesurée 2026-06-10) : array de blocs text dont le
// `text` est une CHAÎNE JSON. C'est CE format que le hook reçoit en prod.
function mcpWrap(obj) {
  return [{ type: 'text', text: JSON.stringify(obj, null, 2) }];
}

function postSearch(sessionId, responseObj) {
  return run({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__odoo__odoo_call',
    session_id: sessionId,
    tool_input: { tool: 'search_records', args: { model: 'product.template' } },
    tool_response: mcpWrap(responseObj),
  });
}

function postGet(sessionId, recordId, responseObj) {
  return run({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__odoo__odoo_call',
    session_id: sessionId,
    tool_input: { tool: 'get_record', args: { model: 'product.template', record_id: recordId } },
    tool_response: mcpWrap(responseObj),
  });
}

function postCreate(sessionId, responseObj) {
  return run({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__odoo__odoo_call',
    session_id: sessionId,
    tool_input: { tool: 'create_record', args: { model: 'product.template' } },
    tool_response: mcpWrap(responseObj),
  });
}

function preMutate(sessionId, op, recordId) {
  return run({
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__odoo__odoo_call',
    session_id: sessionId,
    tool_input: { tool: op, args: { model: 'product.template', record_id: recordId } },
  });
}

const isDeny = (res) => res.stdout.includes('"permissionDecision": "deny"') || res.stdout.includes('"permissionDecision":"deny"');

console.log('odoo-provenance.test.js\n');

// ── Test 1 — RÉGRESSION : enveloppe MCP double-échappée → l'id DOIT être récolté ──
// Avant le fix : extractIds(JSON.stringify(wrapper)) ne matchait jamais "id":N
// (quotes échappées \"id\") → search ne récoltait rien → mutation refusée à tort.
{
  const s = 'test-regress-1';
  postSearch(s, { records: [{ id: 5, name: 'Logo' }, { id: 28, name: 'Flyer' }], total: 2 });
  const allow5 = preMutate(s, 'update_record', 5);
  const allow28 = preMutate(s, 'update_record', 28);
  ok('search_records (wrapper MCP) récolte id 5 → update_record 5 ALLOW', !isDeny(allow5));
  ok('search_records (wrapper MCP) récolte id 28 → update_record 28 ALLOW', !isDeny(allow28));
}

// ── Test 2 — id jamais vu → DENY ──
{
  const s = 'test-deny-2';
  postSearch(s, { records: [{ id: 5, name: 'Logo' }], total: 1 });
  ok('update_record sur id 999 jamais récolté → DENY', isDeny(preMutate(s, 'update_record', 999)));
  ok('delete_record sur id 999 jamais récolté → DENY', isDeny(preMutate(s, 'delete_record', 999)));
}

// ── Test 3 — réponse en ERREUR → id NON récolté ──
{
  const s = 'test-error-3';
  postSearch(s, { error: 'Record does not exist', records: [] });
  // Une réponse search en erreur ne porte pas de "id":N → rien récolté.
  ok('search en erreur → update_record refusé (rien récolté)', isDeny(preMutate(s, 'update_record', 5)));
}

// ── Test 4 — get_record succès : record_id d'ENTRÉE récolté ──
{
  const s = 'test-getok-4';
  postGet(s, 7, { id: 7, name: 'Truc', list_price: 597 });
  ok('get_record succès → update_record 7 ALLOW', !isDeny(preMutate(s, 'update_record', 7)));
}

// ── Test 5 — get_record ERREUR : record_id d'entrée NON récolté ──
{
  const s = 'test-geterr-5';
  postGet(s, 404, { error: 'Record not found' });
  ok('get_record en erreur → update_record 404 DENY (pas de whitelist d\'un id inexistant)', isDeny(preMutate(s, 'update_record', 404)));
}

// ── Test 6 — create_record : record.id récolté depuis l'enveloppe ──
{
  const s = 'test-create-6';
  postCreate(s, { record: { id: 42, name: 'Nouveau' } });
  ok('create_record (wrapper MCP) récolte record.id 42 → update_record 42 ALLOW', !isDeny(preMutate(s, 'update_record', 42)));
}

// ── Test 7 — outils non gatés jamais bloqués (surface RÉELLE backend 0.6.0) ──
{
  const s = 'test-nogate-7';
  ok('search_records jamais gaté (PreToolUse) → ALLOW', !isDeny(run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'search_records', args: { model: 'res.partner' } },
  })));
  // aggregate_records = lecture agrégée, aucun record_id → jamais gaté
  ok('aggregate_records → ALLOW (non mutant, pas de record_id)', !isDeny(run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'aggregate_records', args: { model: 'sale.order', groupby: ['state'] } },
  })));
  // create_record = pas de record_id en entrée → jamais gaté
  ok('create_record → ALLOW (pas d\'id en entrée)', !isDeny(run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'create_record', args: { model: 'res.partner', values: { name: 'X' } } },
  })));
}

// ── Test 8 — isolation par session : id vu en session A invisible en session B ──
{
  const a = 'test-iso-A', b = 'test-iso-B';
  postSearch(a, { records: [{ id: 88, name: 'X' }], total: 1 });
  ok('id 88 vu en session A → ALLOW en A', !isDeny(preMutate(a, 'update_record', 88)));
  ok('id 88 invisible en session B → DENY en B', isDeny(preMutate(b, 'update_record', 88)));
}

// ── Test 9 — post_message MUTE par record_id → même gate que update/delete ──
// Poster sur un id halluciné = écrire dans le chatter du mauvais contact.
{
  const s = 'test-postmsg-9';
  postSearch(s, { records: [{ id: 16, name: 'Alice Martin' }], total: 1 });
  ok('post_message sur id 16 (vu) → ALLOW', !isDeny(preMutate(s, 'post_message', 16)));
  ok('post_message sur id 999 (jamais vu) → DENY', isDeny(preMutate(s, 'post_message', 999)));
}

// ── Test 10 — call_model_method : ids dans arguments[0] (recordset) ──
// Active via ODOO_MCP_ENABLE_METHOD_CALLS. Gate sur la provenance, comme les autres.
{
  const s = 'test-cmm-10';
  postSearch(s, { records: [{ id: 16, name: 'Alice Martin' }], total: 1 });
  const callMethod = (sid, recordset) => run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: sid,
    tool_input: { tool: 'call_model_method', args: { model: 'account.move', method: 'action_post', arguments: recordset } },
  });
  ok('call_model_method action_post sur [[16]] (vu) → ALLOW', !isDeny(callMethod(s, [[16]])));
  ok('call_model_method action_post sur [[999]] (jamais vu) → DENY', isDeny(callMethod(s, [[999]])));
  ok('call_model_method unlink sur [[999]] (jamais vu) → DENY', isDeny(run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'call_model_method', args: { model: 'account.move', method: 'unlink', arguments: [[999]] } },
  })));
  // arguments[0] en STRING JSON (le backend accepte les deux) → doit être parsé.
  ok('call_model_method arguments string-JSON [[999]] (jamais vu) → DENY', isDeny(run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'call_model_method', args: { model: 'account.move', method: 'action_post', arguments: '[[999]]' } },
  })));
}

// ── Test 11 — call_model_method SANS recordset → FAIL-OPEN (zéro faux positif) ──
// arguments[0] = domain (search), vals dict (create), ou absent → pas un recordset
// → ne JAMAIS bloquer (sinon on casse des lectures/créations légitimes).
{
  const s = 'test-cmm-failopen-11';
  const pre = (a) => run({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'call_model_method', args: { model: 'sale.order', method: 'X', arguments: a } },
  });
  ok('arguments[0] = domain [["id","=",5]] (lecture) → ALLOW (pas un recordset)', !isDeny(pre([[['id', '=', 5]]])));
  ok('arguments[0] = vals dict (create) → ALLOW', !isDeny(pre([{ name: 'X' }])));
  ok('arguments absent → ALLOW (méthode statique, pas d\'id)', !isDeny(pre(undefined)));
  ok('arguments = [] → ALLOW', !isDeny(pre([])));
}

// ── Test 12 — call_model_method récolte l'id retourné (chaînage create→mutate) ──
// Une méthode qui crée/retourne un record ("id": N) doit whitelister cet id.
{
  const s = 'test-cmm-harvest-12';
  run({
    hook_event_name: 'PostToolUse', tool_name: 'mcp__odoo__odoo_call', session_id: s,
    tool_input: { tool: 'call_model_method', args: { model: 'sale.advance.payment.inv', method: 'create', arguments: [{}] } },
    tool_response: mcpWrap({ success: true, result: { id: 55 } }),
  });
  ok('id 55 retourné par call_model_method → update_record 55 ALLOW', !isDeny(preMutate(s, 'update_record', 55)));
}

// ── Cleanup state jetable ──
for (const s of sessions) {
  const safe = String(s).replace(/[^a-zA-Z0-9_-]/g, '');
  const f = path.join(STATE_DIR, `odoo-seen-${safe}.json`);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
