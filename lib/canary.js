// ═══════════════════════════════════════════════════════════════════════
// lib/canary.js — CANARY NTFY : tuyau I/O fire-and-forget vers l'opérateur.
// ═══════════════════════════════════════════════════════════════════════
//
// Quand une garde BLOQUE (anti-doublon d'envoi, anti-double-création), un ping
// NTFY part vers le topic d'alertes — c'est la brique « détection » du 0-human
// facturation : l'opérateur voit les déclenchements sans être dans la boucle.
// La logique PURE (parseEnvText, canaryRequest) vit dans lib/readback.js
// (mutée Stryker) ; ICI il n'y a QUE l'I/O.
//
// ⚠️ SIGNAL, PAS UNE GARDE : fail-silent total (conf absente, fichier illisible,
//   réseau mort → false, jamais de throw) et JAMAIS bloquant — on n'attend PAS
//   la réponse NTFY, le blocage de la garde ne dépend d'aucun réseau.
// ⚠️ SANS ÉTAT (module hot-reloadé). JAMAIS de rejet non géré (.catch obligatoire
//   sur le fetch — un unhandledRejection pollue stderr du proxy).
// ⚠️ JAMAIS d'import statique d'un autre module lib/ : le hot-loader cache-bust
//   chaque fichier — un import statique figerait une version périmée. Les
//   fonctions pures arrivent via `helpers` (injectées par handlers.js).
// ⚠️ Secrets HORS repo (convention .claude/secrets/) : le topic NTFY est privé
//   (auth-default-access=deny-all) → rien en dur ici, jamais.
import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";

// helpers = { parseEnvText*, canaryRequest*, readFileSync?, fetchImpl?, envPath? }
// (* = requis, injectés depuis deps ; le reste = overrides de test).
// Retour : true = ping TENTÉ (parti en arrière-plan), false = pas de ping.
export function fireCanary(helpers, title, message) {
  try {
    const read = helpers.readFileSync || readFileSync;
    const fetchImpl = helpers.fetchImpl || fetch;
    const envPath = helpers.envPath || process.env.ODOO_CANARY_ENV
      || path.join(homedir(), ".claude", "secrets", "monitoring-stack.env");
    const req = helpers.canaryRequest(helpers.parseEnvText(read(envPath, "utf8")), title, message);
    if (!req) return false;
    Promise.resolve(fetchImpl(req.url, req.options)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
