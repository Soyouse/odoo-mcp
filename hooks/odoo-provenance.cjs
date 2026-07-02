#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// Hook Pre/PostToolUse — Provenance des IDs Odoo (anti-hallucination)
// ═══════════════════════════════════════════════════════════════════════
//
// PROBLÈME RÉSOLU : un LLM est autorégressif — quand il doit écrire un
// record_id qu'il n'a PAS lu, il en génère un "plausible" (hallucination).
// Sur Odoo les IDs sont des ENTIERS SÉQUENTIELS (6, 14, 71) → un ID inventé
// tombe souvent sur un AUTRE vrai record → mutation silencieuse du mauvais
// enregistrement (incident prouvé : HOSTING-MONTH id 6 archivé par erreur,
// backlog odoo-mcp T-02/T-05).
//
// PARADE = le "Read-before-Edit" des outils natifs, porté à Odoo :
//   on n'autorise une MUTATION par ID que si cet ID a RÉELLEMENT été émis
//   (lu) dans une sortie d'outil de CETTE session. Sinon → DENY.
//   La norme MCP ne couvre PAS ça (elle valide la forme, pas la provenance)
//   → c'est un garde-fou maison. Doctrine : "the model is not a trust
//   boundary" + feedback_operator_is_constant (env, pas "je ferai gaffe").
//
// DEUX ÉVÉNEMENTS, UN FICHIER (branché par hook_event_name) :
//   PostToolUse → RÉCOLTE les IDs réels du tool_response → store de session.
//   PreToolUse  → si update_record/delete_record sur un ID jamais récolté
//                 → DENY (avant tout appel réseau Odoo).
//
// STORE = state/odoo-seen-<session_id>.json (liste d'entiers).
//   ⚠️ CLÉ = session_id → isolation inter-session VOULUE : un ID d'une autre
//   session (ou de la mémoire) N'EST PAS un fait → il faut le re-lire.
//   (cf. "mémoire empoisonnée" : un ID mémorisé n'est pas une vérité live.)
//
// PÉRIMÈTRE (volontairement étroit, zéro faux positif) :
//   GATE les outils qui MUTENT par id =
//   - update_record, delete_record, post_message → param `record_id` (poster sur
//     un id halluciné = écrire dans le mauvais contact).
//   - call_model_method → ids dans `arguments[0]` (recordset Odoo). Activé via
//     ODOO_MCP_ENABLE_METHOD_CALLS (cf. lib/backend.js) : 10e outil du backend
//     0.6.0, gaté car il peut appeler n'importe quelle méthode (dont unlink) et
//     YOLO ne le sécurise pas. C'est l'EX-`execute_method` du backlog — il
//     existait depuis 0.6.0 mais restait MASQUÉ tant que le flag était off.
//   get_record/search_records JAMAIS gatés (ils amorcent la récolte).
//   create_record non gaté (pas d'id en entrée).
//
// ⚠️ FAIL-OPEN OBLIGATOIRE : toute erreur/parse KO → exit(0) (ne JAMAIS
//   bloquer le travail légitime à cause du garde-fou lui-même).
// ⚠️ NE JAMAIS récolter un ID issu d'un appel EN ERREUR (sinon un ID inexistant
//   probé deviendrait "vu" → whitelist d'une hallucination). cf. harvest().
// ⚠️ Format de sortie PreToolUse IMPOSÉ par Claude Code :
//   stdout JSON hookSpecificOutput.permissionDecision + exit(0). Jamais stderr.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// Outils mutateurs gatés directement sur `record_id` (entier propre).
// ⚠️ post_message MUTE le record ciblé (chatter) → un record_id halluciné poste
//   sur le mauvais contact. Même gate que update/delete (param `record_id`).
const GATED = new Set(['update_record', 'delete_record', 'post_message']);

// ⚠️ call_model_method (execute_kw brut, activé via ODOO_MCP_ENABLE_METHOD_CALLS)
//   ne porte PAS de `record_id` : ses ids cible vivent dans `arguments[0]`
//   (convention recordset Odoo : `[[42, 43], ...]`). C'est l'outil le PLUS
//   dangereux (il peut appeler n'importe quelle méthode, dont `unlink`) ET le
//   backend en YOLO ne le sécurise pas → la provenance d'id est sa SEULE garde.
//   Gate identique : un id cible jamais lu cette session → DENY. Extraction des
//   ids = targetIds() (forme spécifique à cet outil). NE PAS retirer : sans ça,
//   call_model_method('account.move','unlink',[[id_halluciné]]) muterait en aveugle.
const GATED_METHOD = 'call_model_method';

// Marqueurs d'échec : si présents dans le tool_response, on ne récolte PAS
// l'id d'entrée d'un get_record (l'enregistrement n'existe pas).
const ERROR_RE = /error|not\s*found|invalid|exception|traceback|does not exist|missing/i;

const stateDir = path.join(__dirname, 'state');

function storeFile(sessionId) {
  // Sanitise le session_id pour un nom de fichier sûr (fail-safe : 'unknown').
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(stateDir, `odoo-seen-${safe || 'unknown'}.json`);
}

function loadSeen(sessionId) {
  try {
    return new Set(JSON.parse(fs.readFileSync(storeFile(sessionId), 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSeen(sessionId, set) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(storeFile(sessionId), JSON.stringify([...set]));
  } catch {
    /* fail-open : si on ne peut pas écrire le store, on ne casse rien */
  }
}

// Normalise le tool_response en TEXTE BRUT exploitable par le regex.
// ⚠️ ROOT CAUSE HISTORIQUE (mesurée 2026-06-10) : Claude Code enveloppe TOUT
//   résultat MCP dans `[{ type:'text', text:'<json>' }]`. Un JSON.stringify
//   naïf de cette enveloppe DOUBLE-échappe les quotes internes (`"id": 5`
//   devient `\"id\": 5`) → le regex `"id":` ne matche JAMAIS → AUCUN id
//   récolté pour search_records/create_record (seul get_record marchait via
//   son record_id d'ENTRÉE). DOIT donc déballer le(s) `.text` AVANT le regex.
// ⚠️ NE PAS revenir à un JSON.stringify direct de l'enveloppe : ça casse la
//   récolte en silence (faux négatif → le gate refuse des mutations légitimes).
function responseText(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  // Enveloppe MCP : array (ou objet .content) de blocs { type:'text', text }.
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : (Array.isArray(toolResponse.content) ? toolResponse.content : null);
  if (blocks) {
    const txt = blocks
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
    if (txt) return txt; // le texte déballé contient le JSON Odoo NON ré-échappé
  }
  try { return JSON.stringify(toolResponse); } catch { return ''; }
}

// Extrait tous les IDs entiers présents comme champ "id" dans le TEXTE déballé.
// Le pattern "id": N couvre le JSON Odoo (records, create_record record.id).
// Un appel en ERREUR ne contient pas "id": N → naturellement non récolté.
function extractIds(text) {
  if (!text) return [];
  const ids = [];
  const re = /"id"\s*:\s*(\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(Number(m[1]));
  return ids;
}

// Récolte les IDs réellement émis par un appel odoo_call réussi.
function harvest(sessionId, toolName, toolInput, toolResponse) {
  if (toolName !== 'mcp__odoo__odoo_call') return;
  const op = toolInput && toolInput.tool;
  const respStr = responseText(toolResponse); // texte déballé (cf. responseText)

  const seen = loadSeen(sessionId);
  let changed = false;

  for (const id of extractIds(respStr)) {
    if (!seen.has(id)) { seen.add(id); changed = true; }
  }

  // get_record rendu en texte : l'id peut ne pas être au format "id": N.
  // On ajoute record_id SEULEMENT si la réponse n'est pas une erreur
  // (sinon on whitelisterait un id inexistant qu'on a juste probé).
  if (op === 'get_record' && toolInput.args && respStr && !ERROR_RE.test(respStr)) {
    const rid = Number(toolInput.args.record_id);
    if (Number.isInteger(rid) && !seen.has(rid)) { seen.add(rid); changed = true; }
  }

  if (changed) saveSeen(sessionId, seen);
}

// Renvoie la liste des record_id ciblés par une mutation (toujours entiers).
// Deux formes selon l'outil :
//   - update/delete/post_message → param `record_id` (entier ou liste).
//   - call_model_method → `arguments[0]` = recordset Odoo (`[[42, 43], ...]`).
// ⚠️ Pour call_model_method, on NE traite arguments[0] comme un recordset QUE si
//   c'est une liste dont TOUS les éléments sont des entiers. Sinon (domain
//   `[['id','=',5]]`, vals dict d'un create, méthode statique) → [] → FAIL-OPEN :
//   pas de faux positif qui bloquerait une lecture/création légitime.
function targetIds(toolInput) {
  const args = (toolInput && toolInput.args) || {};
  const op = toolInput && toolInput.tool;

  if (op === GATED_METHOD) {
    let a = args.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
    if (!Array.isArray(a) || a.length === 0) return []; // pas de recordset → fail-open
    const first = a[0];
    const arr = Array.isArray(first) ? first : [first];
    // Recordset = QUE des entiers. Toute autre forme (domain, dict…) → fail-open.
    if (arr.length === 0 || !arr.every((x) => Number.isInteger(x))) return [];
    return arr;
  }

  const raw = args.record_id;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(Number).filter(Number.isInteger);
}

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// ── Lecture stdin (format Claude Code hooks) ──
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const event = data.hook_event_name;
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const sessionId = data.session_id;

    if (toolName !== 'mcp__odoo__odoo_call') process.exit(0);

    if (event === 'PostToolUse') {
      harvest(sessionId, toolName, toolInput, data.tool_response);
      process.exit(0);
    }

    if (event === 'PreToolUse') {
      const op = toolInput.tool;

      // Gate les mutations par record_id (update/delete/post_message) ET
      // call_model_method (ids dans arguments[0]). Tout le reste passe.
      if (!GATED.has(op) && op !== GATED_METHOD) process.exit(0); // lecture, create, agrégat…
      const ids = targetIds(toolInput);

      if (ids.length === 0) process.exit(0); // pas d'id clair → laisser passer (fail-open)

      const seen = loadSeen(sessionId);
      const missing = ids.filter((id) => !seen.has(id));
      if (missing.length > 0) {
        deny(
          `🛑 PROVENANCE — ${op} sur record_id ${missing.join(', ')} REFUSÉ.\n` +
          `Cet ID n'a jamais été retourné par une lecture (search_records/get_record) ` +
          `dans CETTE session. Risque d'hallucination d'ID (mutation du mauvais record).\n` +
          `→ D'ABORD : get_record/search_records pour LIRE l'ID réel, PUIS re-tente la mutation.\n` +
          `(Un ID venant de la mémoire ou d'une autre session n'est PAS un fait live.)`
        );
      }
      process.exit(0);
    }

    process.exit(0);
  } catch {
    process.exit(0); // fail-open
  }
});
