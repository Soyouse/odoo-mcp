// ═══════════════════════════════════════════════════════════════════════
// lib/readback.js — « MCP VOYANT » : plans de relecture post-écriture +
// garde anti-doublon d'envoi de facture. FONCTIONS PURES.
// ═══════════════════════════════════════════════════════════════════════
//
// PROBLÈME RÉSOLU (incident doublon de facturation, 2026-07-01) : le backend pip est
// AVEUGLE sur les écritures — `call_model_method` relaie le retour brut d'Odoo
// (souvent `null` : generate_invoice, action_post…) et create/update ne
// renvoient que id+display_name. L'agent validait donc des actions sans voir
// leurs effets (facture créée ET envoyée en silence → renvoi → doublon).
// ICI on planifie : (1) quelle relecture faire après chaque écriture pour
// remonter l'ÉTAT RÉEL, (2) quels envois bloquer car déjà effectués.
//
// ⚠️ FONCTIONS PURES : aucun I/O — l'exécution des plans (appels backend) vit
//   dans lib/handlers.js. Pur = unit-testable + muté par Stryker (stryker.conf).
// ⚠️ ROBUSTESSE AUX MAJ ODOO : ne s'appuyer QUE sur des invariants stables —
//   méthodes ORM `search_records`/`read` (inchangées v10→v19) et champs vérifiés
//   présents en 17 ET 18 (source 18.0 audité 2026-07-02) : `state`,
//   `payment_state`, `is_move_sent` (account.move), `invoice_ids`
//   (sale.subscription, subscription_oca). JAMAIS de dépendance à la FORME du
//   retour d'une méthode métier (fragile) — on relit TOUJOURS en base après.
// ⚠️ JAMAIS de throw : entrée invalide → null (plan impossible = pas de plan).

// Champs stables relus par modèle. Fallback = display_name + write_date
// (colonnes magiques, présentes sur TOUT modèle Odoo).
// ⚠️ N'ajouter ici QUE des champs vérifiés dans le source des DEUX versions
//   courantes (17 + cible de migration) — un champ disparu casserait la
//   relecture (fail-safe : warning, mais on perd la vision).
const STABLE_FIELDS = {
  "account.move": ["name", "state", "payment_state", "is_move_sent", "amount_total", "partner_id"],
  "sale.subscription": ["display_name", "invoice_ids"],
  "sale.order": ["name", "state", "invoice_status", "amount_total"],
  "res.partner": ["display_name", "email", "phone", "city"],
};
const DEFAULT_FIELDS = ["display_name", "write_date"];
// Champs relus par la GARDE anti-doublon (état d'envoi).
export const GUARD_FIELDS = ["name", "state", "payment_state", "is_move_sent"];

// Cap de relecture : borne le contexte renvoyé, JAMAIS la garde (sécurité).
const MAX_READBACK_IDS = 10;

export function stableFieldsFor(model) {
  return STABLE_FIELDS[model] || DEFAULT_FIELDS;
}

// ─── CAPABILITY DETECTION (état de l'art connecteurs Odoo : introspection
// métadonnées, jamais d'affirmation aveugle) ───
// Croise les champs SOUHAITÉS avec les champs RÉELS du serveur (lus via la
// resource `odoo://<model>/fields`, cachée par process). Un champ absent chez
// cet Odoo (autre version, module manquant) est simplement omis — la relecture
// marche PARTOUT au lieu d'échouer sur un « Invalid field ».
// Fail-safe : liste réelle indisponible (null/vide) → souhaits inchangés
// (comportement historique) ; intersection vide → fallback universel.
export function intersectFields(wanted, availableNames) {
  if (!Array.isArray(availableNames) || availableNames.length === 0) return wanted;
  const avail = new Set(availableNames);
  const kept = wanted.filter((f) => avail.has(f));
  return kept.length ? kept : DEFAULT_FIELDS.filter((f) => avail.has(f) || f === "display_name");
}

// Message de dégradation ANNONCÉE de la garde : cet Odoo n'expose pas le champ
// décisif → on ne peut PAS garantir l'anti-doublon, on le dit (≠ erreur transitoire).
export function formatGuardIncapable() {
  return (
    "🛑 GARDE ANTI-DOUBLON : ce serveur Odoo n'expose PAS `is_move_sent` → impossible de garantir " +
    "qu'un envoi n'est pas un doublon. Vérifie l'historique d'envoi autrement, puis envoie en " +
    "connaissance de cause avec args.force_resend: true."
  );
}

// Parse un tableau d'ids positifs. Tolère la string JSON (le backend accepte
// `arguments` en JSON string — on doit comprendre les MÊMES formes que lui).
export function toIdArray(x) {
  let v = x;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const ids = v.filter((n) => Number.isInteger(n) && n > 0);
  return ids.length === v.length ? ids : [];
}

// Ids contenus dans des commandes ORM x2many ((4,id), (6,0,[ids]), id nu).
// Format de commandes STABLE depuis Odoo 8 — sûr d'en dépendre.
export function extractCommandIds(commands) {
  if (!Array.isArray(commands)) return [];
  const out = [];
  for (const c of commands) {
    if (Number.isInteger(c) && c > 0) out.push(c);
    else if (Array.isArray(c)) {
      if (c[0] === 4 && Number.isInteger(c[1])) out.push(c[1]);
      else if (c[0] === 6 && Array.isArray(c[2])) out.push(...c[2].filter((n) => Number.isInteger(n) && n > 0));
    }
  }
  return [...new Set(out)];
}

// Id créé : le backend renvoie {"success":true,"record":{"id":N,...}} (JSON
// texte). Fallback = message "…with ID N". Sinon null (pas de plan).
export function parseCreatedId(resultText) {
  if (typeof resultText !== "string") return null;
  try {
    const obj = JSON.parse(resultText);
    const id = obj?.record?.id;
    if (Number.isInteger(id) && id > 0) return id;
  } catch {}
  const m = resultText.match(/with ID (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Records d'un résultat search_records ({"records":[...],...}). null si illisible.
export function parseSearchRecords(resultText) {
  if (typeof resultText !== "string") return null;
  try {
    const obj = JSON.parse(resultText);
    return Array.isArray(obj?.records) ? obj.records : null;
  } catch { return null; }
}

// ─── PLAN DE RELECTURE post-écriture ───
// → { model, ids, fields } ou null (rien à relire / plan impossible).
export function readbackPlan(toolName, callArgs, resultText) {
  const model = callArgs?.model;
  if (typeof model !== "string" || model === "") return null;

  let ids = [];
  if (toolName === "create_record") {
    const id = parseCreatedId(resultText);
    ids = id ? [id] : [];
  } else if (toolName === "update_record") {
    const id = callArgs?.record_id;
    ids = Number.isInteger(id) && id > 0 ? [id] : [];
  } else if (toolName === "call_model_method") {
    // execute_kw : les ids sont le 1er positional (arguments[0]).
    let a = callArgs?.arguments;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
    ids = Array.isArray(a) ? toIdArray(a[0]) : [];
  } else {
    return null; // outil non-écriture (ou delete : rien à relire, record mort)
  }

  if (ids.length === 0) return null;
  return { model, ids: ids.slice(0, MAX_READBACK_IDS), fields: stableFieldsFor(model) };
}

// ─── CASCADE abonnement → factures ───
// Après une écriture sur sale.subscription (ex. generate_invoice, retour null
// côté Odoo), l'état UTILE est sur les FACTURES liées → 2e relecture sur les
// invoice_ids les plus récents. C'est LA fermeture du trou du retour muet.
export function cascadePlan(model, records) {
  if (model !== "sale.subscription" || !Array.isArray(records)) return null;
  const ids = [...new Set(records.flatMap((r) => toIdArray(r?.invoice_ids)))]
    .sort((a, b) => b - a)
    .slice(0, 5);
  return ids.length ? { model: "account.move", ids, fields: stableFieldsFor("account.move") } : null;
}

// ─── GARDE ANTI-DOUBLON d'envoi ───
// Détecte un appel qui (ré)ENVOIE des factures → { model:"account.move", ids }
// à vérifier (is_move_sent) AVANT d'exécuter. Chemins couverts :
//  1. call_model_method account.move + méthode contenant "send" (action_send_
//     and_print, send_and_print…).
//  2. create_record account.move.send* (wizard d'envoi : ids dans values.move_ids
//     — commandes ORM). Créer le wizard déclenche la chaîne d'envoi ensuite →
//     on gate à la création.
// null = appel non concerné.
export function sendGuardPlan(toolName, callArgs) {
  const model = callArgs?.model;
  if (typeof model !== "string") return null;

  if (toolName === "call_model_method" && model === "account.move" && /send/i.test(String(callArgs?.method || ""))) {
    let a = callArgs?.arguments;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
    const ids = Array.isArray(a) ? toIdArray(a[0]) : [];
    return ids.length ? { model: "account.move", ids } : null;
  }

  if (toolName === "create_record" && model.startsWith("account.move.send")) {
    const ids = extractCommandIds(callArgs?.values?.move_ids);
    return ids.length ? { model: "account.move", ids } : null;
  }

  return null;
}

// ─── SCAN EMAILS/NOTIFICATIONS partis pendant l'appel ───
// Le danger n°1 = un email client qui part en silence (méthode Odoo muette,
// incident du 2026-07-01). Signal MESURÉ en prod (01/07) : un envoi réel = un
// `mail.message` avec `partner_ids` NON vide (les tracking notes internes ont
// partner_ids vide). Champs vérifiés identiques en 17 ET 18 (source audité).
// Protocole : snapshot du dernier id AVANT l'écriture → scan `id > snapshot`
// APRÈS → tout destinataire notifié pendant l'appel est remonté.
export const MAIL_SCAN_TOOLS = new Set(["create_record", "update_record", "call_model_method", "post_message"]);
const MAIL_SCAN_FIELDS = ["message_type", "subject", "email_from", "partner_ids", "model", "res_id"];

export function mailSnapshotCall() {
  return { model: "mail.message", domain: [], fields: ["id"], limit: 1, order: "id desc" };
}

export function mailScanCall(lastId) {
  return {
    model: "mail.message",
    domain: [["id", ">", lastId], ["partner_ids", "!=", false]],
    fields: MAIL_SCAN_FIELDS,
    limit: 10,
    order: "id asc",
  };
}

// Id du dernier mail.message (résultat du snapshot). 0 = base vide (valide).
// null = snapshot illisible → le scan serait un mensonge, on s'abstient.
export function latestMessageId(records) {
  if (!Array.isArray(records)) return null;
  if (records.length === 0) return 0;
  const id = records[0]?.id;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function formatMailReport(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "📧 Aucun destinataire notifié pendant l'appel (aucun email parti).";
  const lines = messages.map((m) => `mail.message ${JSON.stringify(m)}`);
  return `📧 ${messages.length} MESSAGE(S) PARTI(S) VERS DES DESTINATAIRES PENDANT L'APPEL — en tenir compte AVANT tout renvoi :\n${lines.join("\n")}`;
}

// ─── GARDE ANTI-DOUBLE-CRÉATION de facture d'abonnement ───
// LE trou « argent » : relancer generate_invoice sur un abo déjà facturé ce
// mois-ci = 2e CRÉANCE réelle pour le client (pire qu'un email en double).
// Champs : `invoice_date` (comptabilité core) avec repli `create_date`
// (colonne magique universelle). Une facture annulée (state=cancel) ne compte pas.
const CREATE_METHODS = /^(generate_invoice|create_invoice)$/;
export const CREATE_GUARD_FIELDS = ["name", "state", "invoice_date", "create_date", "amount_total"];

export function createGuardPlan(toolName, callArgs) {
  if (toolName !== "call_model_method" || callArgs?.model !== "sale.subscription") return null;
  if (!CREATE_METHODS.test(String(callArgs?.method || ""))) return null;
  let a = callArgs?.arguments;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
  const ids = Array.isArray(a) ? toIdArray(a[0]) : [];
  return ids.length ? { model: "sale.subscription", ids } : null;
}

// Factures déjà émises DANS LE MOIS COURANT (nowMonth = "YYYY-MM", injecté par
// l'appelant → fonction PURE, testable, mutable).
export function duplicateInvoices(records, nowMonth) {
  if (!Array.isArray(records) || typeof nowMonth !== "string" || nowMonth === "") return [];
  return records.filter((r) => r?.state !== "cancel" && String(r?.invoice_date || r?.create_date || "").startsWith(nowMonth));
}

export function formatCreateGuardBlock(dupes) {
  const lines = dupes.map((d) => `account.move ${JSON.stringify(d)}`);
  return (
    `🛑 GARDE ANTI-DOUBLE-CRÉATION : facturation BLOQUÉE — une facture existe DÉJÀ ce mois-ci pour cet abonnement :\n${lines.join("\n")}\n` +
    `Relancer la facturation = 2e créance réelle pour le client. ` +
    `Si c'est VOULU et assumé (rattrapage, complément…), rappelle avec args.force_create: true.`
  );
}

// ─── PIÈGES CONNUS (savoir métier injecté DANS le tuyau) ───
// Un agent SANS le skill /crm doit quand même être prévenu au moment exact où
// il touche une méthode piégeuse — le savoir vit dans le proxy, pas seulement
// dans la doc (leçon de l'incident 2026-07-01 : l'agent ignorait qu'un generate_invoice
// pouvait envoyer l'email lui-même). Chaque entrée = model + regex méthode +
// avertissement appendu au résultat de l'appel.
const PITFALLS = [
  {
    model: "sale.subscription",
    method: /invoice/i,
    warning:
      "⚠️ PIÈGE CONNU : si le template d'abonnement est en invoicing_mode=invoice_send, cette méthode CRÉE ET ENVOIE " +
      "l'email de facture au client dans la même transaction, silencieusement. Vérifie le bloc 📧 ci-dessus — " +
      "si un email est parti, NE PAS renvoyer (doublon, incident du 2026-07-01).",
  },
  {
    model: "mail.template",
    method: /^send_mail$/i,
    warning:
      "⚠️ PIÈGE CONNU : mail.mail est AUTO-SUPPRIMÉ après envoi réussi → l'absence de record ≠ échec (state=exception = échec réel). " +
      "Et « envoyé » côté Odoo ≠ délivré côté destinataire (DMARC) : pour un envoi client sensible, vérifier la réception réelle.",
  },
  {
    model: "sale.order",
    method: /^action_cancel$/i,
    warning:
      "⚠️ PIÈGE CONNU : un devis confirmé/verrouillé exige action_unlock D'ABORD ; si un wizard sale.order.cancel est retourné, " +
      "LIRE son id réel avant d'appeler sa méthode (jamais d'id supposé).",
  },
];

export function pitfallWarning(toolName, callArgs) {
  if (toolName !== "call_model_method") return null;
  const model = callArgs?.model;
  if (typeof model !== "string") return null;
  const method = String(callArgs?.method || "");
  const hit = PITFALLS.find((p) => p.model === model && p.method.test(method));
  return hit ? hit.warning : null;
}

// ─── CANARY NTFY (détection 0-human : garde déclenchée = ping opérateur) ───
// Une garde qui BLOQUE est un événement de sécurité : sans humain dans la
// boucle, personne ne le voit à part l'agent bloqué. Ici = la logique PURE
// (parse env + construction requête) ; le tuyau I/O fire-and-forget vit dans
// lib/canary.js. Le canary est un SIGNAL, jamais une garde : son échec ne
// change RIEN au blocage.

// Parse un fichier KEY=value (convention .claude/secrets/*.env). Commentaires
// et lignes malformées ignorés. Non-string → {} (fail-silent).
export function parseEnvText(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Requête NTFY prête à fetch : { url, options } ou null si la conf est
// incomplète (pas d'URL/topic = pas de canary, jamais une erreur).
// ⚠️ Title = header HTTP → ASCII imprimable UNIQUEMENT (undici rejette le
//   non-latin1 → le ping partirait à la poubelle) ; le corps reste en UTF-8.
export function canaryRequest(env, title, message) {
  const url = env?.NTFY_URL, topic = env?.NTFY_TOPIC;
  if (typeof url !== "string" || url === "" || typeof topic !== "string" || topic === "") return null;
  const headers = {
    Title: String(title ?? "").replace(/[^\x20-\x7E]/g, "").trim() || "Odoo MCP",
    Priority: "high",
    Tags: "rotating_light,odoo",
  };
  if (env.NTFY_USER && env.NTFY_PASS) {
    headers.Authorization = "Basic " + Buffer.from(`${env.NTFY_USER}:${env.NTFY_PASS}`).toString("base64");
  }
  return { url: `${url.replace(/\/+$/, "")}/${topic}`, options: { method: "POST", headers, body: String(message ?? "") } };
}

// ─── Formatage (texte ajouté au résultat) ───
// ⚠️ Records émis en JSON compact (`{"id":9,...}`) VOLONTAIREMENT : le hook
//   odoo-provenance récolte /"id"\s*:\s*(\d+)/ dans les réponses → les ids
//   relus (dont la cascade abo→factures) deviennent actionnables sans
//   re-lecture. NE PAS reformater en prose sans garder `"id": N`.
export function formatReadback(model, records, requestedIds) {
  const lines = (records || []).map((r) => `${model} ${JSON.stringify(r)}`);
  const found = new Set((records || []).map((r) => r.id));
  const missing = (requestedIds || []).filter((id) => !found.has(id));
  if (missing.length) lines.push(`⚠️ INTROUVABLES en base : #${missing.join(", #")} (supprimés ou jamais créés)`);
  return `═══ ÉTAT RÉEL APRÈS ÉCRITURE (relu en base) ═══\n${lines.join("\n")}`;
}

export function formatGuardBlock(sentRecords) {
  const lines = sentRecords.map((r) => `account.move #${r.id} ${r.name || ""} — is_move_sent: true · state: ${r.state} · payment_state: ${r.payment_state}`);
  return (
    `🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ — facture(s) DÉJÀ ENVOYÉE(S) au client :\n${lines.join("\n")}\n` +
    `Renvoyer = email en double chez le client (incident du 2026-07-01). ` +
    `Si le renvoi est VOULU et assumé, rappelle avec args.force_resend: true.`
  );
}
