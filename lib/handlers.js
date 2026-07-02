// ═══════════════════════════════════════════════════════════════════════
// lib/handlers.js — LOGIQUE MÉTIER des 2 méta-outils (discover + call).
// ═══════════════════════════════════════════════════════════════════════
//
// C'est ICI que vivent les features (formatage discover, validation précoce,
// routage isError, enrichissement champs). Le shell (proxy.js) ne fait que
// router vers ces fonctions → AJOUTER UNE FEATURE = éditer CE fichier, JAMAIS
// le shell. Et comme ce module est SANS ÉTAT (le backend est passé en argument),
// le shell le HOT-RELOAD à chaud (cache-bust mtime) → modif live sans reconnect.
//
// ⚠️ SANS ÉTAT : ne RIEN mémoriser au niveau module (pas de cache, pas de
//   compteur). Tout l'état vivant (connexion backend) appartient à BackendMCP,
//   passé en argument. Sinon le hot-reload repartirait d'un état vierge à chaque
//   édition = bugs fantômes.
// ⚠️ Dépendances INJECTÉES via makeHandlers(deps) — le shell fusionne les exports
//   de TOUS les modules lib/ auto-découverts (même version, hot-reload cohérent)
//   et rend les handlers testables avec des deps factices.
// ⚠️ JAMAIS de throw qui remonte : tout retourne un objet réponse MCP
//   { content:[...], isError? }. Le backend peut throw (transport) → catch local.

export function makeHandlers(deps) {
  const {
    validateCall, parseInvalidField, extractFieldNames, formatFieldHint,
    readbackPlan, cascadePlan, sendGuardPlan, parseSearchRecords,
    formatReadback, formatGuardBlock, GUARD_FIELDS,
    MAIL_SCAN_TOOLS, mailSnapshotCall, mailScanCall, latestMessageId, formatMailReport,
    intersectFields, formatGuardIncapable, pitfallWarning,
    createGuardPlan, duplicateInvoices, formatCreateGuardBlock, CREATE_GUARD_FIELDS,
    parseEnvText, canaryRequest, fireCanary,
  } = deps;

  // CANARY : chaque BLOCAGE de garde = ping NTFY opérateur (détection 0-human).
  // Fire-and-forget, fail-silent — le canary ne conditionne JAMAIS le blocage
  // (fireCanary absent des deps = noop, jamais un crash). Titre en ASCII pur
  // (header HTTP). Réservé aux GARDES : pas de ping sur les erreurs ordinaires.
  const blocked = (text) => {
    if (typeof fireCanary === "function") fireCanary({ parseEnvText, canaryRequest }, "Garde Odoo MCP declenchee", text);
    return { content: [{ type: "text", text }], isError: true };
  };

  // CAPABILITY DETECTION : champs réels d'un modèle via la resource fields
  // (cache par process côté backend). null = introuvable/illisible → l'appelant
  // garde ses champs souhaités (fail-safe, comportement historique).
  async function availableFields(backend, model) {
    try {
      const text = await backend.readResourceCached(`odoo://${model}/fields`);
      const names = extractFieldNames(text);
      return Array.isArray(names) && names.length ? names : null;
    } catch {
      return null;
    }
  }

  // search_records générique → records[] ou null. Fail-safe TOTAL : toute
  // erreur (transport, isError, JSON illisible) → null. L'appelant décide
  // quoi faire d'un null (warning voyant / blocage garde / silence mail).
  async function runSearch(backend, callArgs) {
    try {
      const { content, isError } = await backend.callTool("search_records", callArgs);
      if (isError) return null;
      const text = (Array.isArray(content) ? content : []).map((b) => (b && b.text) || "").join("");
      return parseSearchRecords(text);
    } catch {
      return null;
    }
  }

  // Exécute un plan de relecture { model, ids, fields }. Les champs souhaités
  // sont croisés avec les champs RÉELS du serveur (capability detection) →
  // marche sur tout Odoo, même sans nos modules ou après un renommage de major.
  async function runReadback(backend, plan) {
    const fields = intersectFields(plan.fields, await availableFields(backend, plan.model));
    return runSearch(backend, { model: plan.model, domain: [["id", "in", plan.ids]], fields, limit: plan.ids.length });
  }

  // Enrichissement « Invalid field » UNIFIÉ : appelé par les DEUX chemins d'échec
  // (résultat isError ET exception transport). Renvoie un content[] enrichi ou
  // null. Fail-safe : toute erreur interne → null (l'appelant garde le message
  // d'origine). Découverte via RESOURCE (PAS de tool fields_get dans ce backend).
  async function enrichFieldError(backend, errText, model) {
    const badField = parseInvalidField(errText);
    if (!badField || typeof model !== "string") return null;
    try {
      const text = await backend.readResource(`odoo://${model}/fields`);
      const hint = formatFieldHint(model, badField, extractFieldNames(text));
      return hint ? [{ type: "text", text: hint }] : null;
    } catch {
      return null;
    }
  }

  async function handleDiscover(backend) {
    try {
      const tools = await backend.getTools();
      const lines = tools.map((t) => {
        const params = t.inputSchema?.properties
          ? Object.entries(t.inputSchema.properties)
              .map(([k, v]) => {
                const req = t.inputSchema.required?.includes(k) ? "*" : "";
                return `${k}${req}: ${v.type || "any"} — ${v.description || ""}`;
              })
              .join("\n      ")
          : "(no params)";
        return `## ${t.name}\n  ${t.description}\n  Params:\n      ${params}`;
      });
      return { content: [{ type: "text", text: `Odoo CRM tools (${lines.length}):\n\n${lines.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error (backend unavailable): ${e.message}\nRetry on next call — proxy is alive.` }], isError: true };
    }
  }

  async function handleCall(backend, args) {
    const toolName = args?.tool;
    // Validation PRÉCOCE : forme + nom contre le cache, AVANT tout I/O réseau →
    // erreur immédiate et explicite au lieu d'un freeze/erreur tardive.
    const invalid = validateCall(toolName, args?.args, backend.knownToolNames());
    if (invalid) return { content: [{ type: "text", text: invalid.error }], isError: true };

    // `force_resend`/`force_create` = paramètres PROXY (overrides des gardes),
    // TOUJOURS retirés avant transmission (le backend rejette les params inconnus).
    const { force_resend, force_create, ...toolArgs } = args?.args || {};
    const model = toolArgs?.model;

    // ─── GARDE ANTI-DOUBLON (avant exécution) ───
    // Un (ré)envoi de facture déjà `is_move_sent` = email en double chez le
    // client → BLOQUÉ, sauf force_resend:true explicite. FAIL-CLOSED : si la
    // vérification est impossible (backend KO), on bloque aussi — un envoi
    // client ne part JAMAIS sans preuve de son état (incident doublon 2026-07-01).
    const guard = sendGuardPlan(toolName, toolArgs);
    if (guard && force_resend !== true) {
      // Capability : si cet Odoo n'expose PAS is_move_sent (métadonnées lues,
      // champ absent — ≠ erreur transitoire), la garde est INAPPLICABLE → on
      // l'annonce clairement au lieu de bloquer sur un mensonge.
      const avail = await availableFields(backend, guard.model);
      if (avail && !avail.includes("is_move_sent")) {
        return blocked(formatGuardIncapable());
      }
      const records = await runReadback(backend, { ...guard, fields: GUARD_FIELDS });
      if (!records) {
        return blocked("🛑 GARDE ANTI-DOUBLON : impossible de vérifier l'état d'envoi (relecture KO) → envoi BLOQUÉ par prudence. Réessaie, ou args.force_resend: true si l'envoi est voulu et vérifié autrement.");
      }
      const sent = records.filter((r) => r.is_move_sent === true);
      if (sent.length) return blocked(formatGuardBlock(sent));
    }

    // ─── GARDE ANTI-DOUBLE-CRÉATION (avant exécution) ───
    // Relancer la facturation d'un abo déjà facturé CE MOIS-CI = 2e créance
    // réelle → BLOQUÉ, sauf force_create:true explicite. FAIL-CLOSED : état
    // invérifiable = pas de facturation à l'aveugle (c'est de l'argent client).
    const createGuard = createGuardPlan(toolName, toolArgs);
    if (createGuard && force_create !== true) {
      const subs = await runReadback(backend, { ...createGuard, fields: ["display_name", "invoice_ids"] });
      if (!subs) {
        return blocked("🛑 GARDE ANTI-DOUBLE-CRÉATION : impossible de vérifier les factures existantes de cet abonnement (relecture KO) → facturation BLOQUÉE par prudence. Réessaie, ou args.force_create: true si l'état a été vérifié autrement.");
      }
      const cascade = cascadePlan("sale.subscription", subs);
      if (cascade) {
        const invoices = await runReadback(backend, { ...cascade, fields: CREATE_GUARD_FIELDS });
        if (!invoices) {
          return blocked("🛑 GARDE ANTI-DOUBLE-CRÉATION : factures liées illisibles → facturation BLOQUÉE par prudence. Réessaie, ou args.force_create: true si l'état a été vérifié autrement.");
        }
        const dupes = duplicateInvoices(invoices, new Date().toISOString().slice(0, 7));
        if (dupes.length) return blocked(formatCreateGuardBlock(dupes));
      }
    }

    // ─── SNAPSHOT MAIL (avant l'écriture) ───
    // Baseline du scan post-appel : dernier mail.message existant. null =
    // snapshot illisible → on ne PRÉTENDRA rien sur les emails après l'appel.
    let mailBaseline = null;
    if (MAIL_SCAN_TOOLS.has(toolName)) {
      mailBaseline = latestMessageId(await runSearch(backend, mailSnapshotCall()));
    }

    try {
      const { content, isError } = await backend.callTool(toolName, toolArgs);
      // Erreur d'OUTIL : renvoyée en résultat isError (PAS une exception). On tente
      // l'enrichissement champs sur CE chemin (le vrai chemin prod des « Invalid
      // field »), sinon on propage tel quel + isError.
      if (isError) {
        const errText = (Array.isArray(content) ? content : []).map((b) => (b && b.text) || "").join("");
        const enriched = await enrichFieldError(backend, errText, model);
        return enriched ? { content: enriched, isError: true } : { content, isError: true };
      }

      // ─── MCP VOYANT (après écriture réussie) ───
      // Odoo est souvent MUET sur les écritures (retour null) → on relit
      // TOUJOURS l'état réel en base et on l'ajoute au résultat. Fail-safe :
      // l'écriture a RÉUSSI quoi qu'il arrive — une relecture KO ajoute un
      // warning, elle n'échoue JAMAIS l'appel.
      const out = Array.isArray(content) ? [...content] : [];
      const resultText = out.map((b) => (b && b.text) || "").join("");
      const plan = readbackPlan(toolName, toolArgs, resultText);
      if (plan) {
        const records = await runReadback(backend, plan);
        if (records) {
          out.push({ type: "text", text: formatReadback(plan.model, records, plan.ids) });
          // Cascade abonnement → factures : l'effet d'un generate_invoice est
          // sur les account.move liés, pas sur l'abo → 2e relecture.
          const cascade = cascadePlan(plan.model, records);
          if (cascade) {
            const invoices = await runReadback(backend, cascade);
            if (invoices) out.push({ type: "text", text: formatReadback(cascade.model, invoices, cascade.ids) });
          }
        } else {
          out.push({ type: "text", text: "⚠️ Écriture EFFECTUÉE mais relecture de vérification KO — AVANT toute autre action, vérifie l'état réel via get_record/search_records." });
        }
      }

      // ─── SCAN MAIL (après l'écriture) ───
      // Remonte tout mail.message avec destinataires créé PENDANT l'appel —
      // c'est l'envoi silencieux (generate_invoice & co) rendu VISIBLE.
      // Baseline ou scan KO → on le DIT (silence ≠ « aucun email parti »).
      if (MAIL_SCAN_TOOLS.has(toolName)) {
        const msgs = mailBaseline === null ? null : await runSearch(backend, mailScanCall(mailBaseline));
        out.push({
          type: "text",
          text: msgs === null
            ? "⚠️ Vérification des envois d'emails IMPOSSIBLE pour cet appel — contrôler le chatter avant tout (re)envoi."
            : formatMailReport(msgs),
        });
      }

      // ─── PIÈGE CONNU (savoir métier dans le tuyau) ───
      // Averti même un agent qui n'a chargé aucun skill — au moment exact
      // où il touche une méthode piégeuse.
      const pitfall = pitfallWarning(toolName, toolArgs);
      if (pitfall) out.push({ type: "text", text: pitfall });

      return out.length ? { content: out } : { content };
    } catch (e) {
      // Erreur de TRANSPORT/JSON-RPC (backend down, timeout) : remontée en
      // exception. Même enrichissement, même fail-safe.
      const enriched = await enrichFieldError(backend, e.message, model);
      return enriched
        ? { content: enriched, isError: true }
        : { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }

  return { handleDiscover, handleCall };
}
