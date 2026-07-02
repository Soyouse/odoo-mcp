// ═══════════════════════════════════════════════════════════════════════
// lib/config.js — Résolution de la config du proxy (env overrides + défauts).
// ═══════════════════════════════════════════════════════════════════════
//
// PUR : ne lit QUE `env` + `baseDir` passés en argument → aucun accès direct à
//   process.env / __dirname / fichier ici → unit-testable, zéro effet de bord.
// ⚠️ baseDir DOIT être le dossier de proxy.js (racine repo) : le défaut secrets
//   `../infra-mcp/.secrets.json` en dépend. Le shell (proxy.js) l'injecte avec
//   SON propre __dirname → pas de bug de chemin si ce module bouge dans lib/.
// ⚠️ Défauts = comportement HISTORIQUE. Toute valeur JSON invalide → on retombe
//   silencieusement sur le défaut (jamais de throw : un env mal formé ne doit
//   pas empêcher le proxy de démarrer).

import path from "path";

export function loadProxyConfig(env, baseDir) {
  const secretsPath = env.ODOO_SECRETS_PATH
    ? path.resolve(env.ODOO_SECRETS_PATH)
    : path.resolve(baseDir, "../infra-mcp/.secrets.json");

  // Creds Odoo par ENV (portable, first-class) : si l'essentiel est présent,
  // le fichier secrets n'est JAMAIS lu. Auth = ODOO_API_KEY OU login+password
  // (ODOO_USER, alias ODOO_LOGIN). Incomplet → null → fichier (historique).
  const e = (k) => (typeof env[k] === "string" && env[k] !== "" ? env[k] : null);
  const url = e("ODOO_URL"), db = e("ODOO_DB");
  const login = e("ODOO_USER") || e("ODOO_LOGIN");
  const password = e("ODOO_PASSWORD"), apiKey = e("ODOO_API_KEY");
  const odooCreds = url && db && (apiKey || (login && password))
    ? { url, db, login, password, apiKey }
    : null;

  const python = env.ODOO_PYTHON || "python";

  let backendCmd = [python, "-m", "mcp_server_odoo", "--transport", "stdio"];
  if (env.ODOO_BACKEND_CMD) {
    try {
      const a = JSON.parse(env.ODOO_BACKEND_CMD);
      if (Array.isArray(a) && a.length) backendCmd = a;
    } catch { /* JSON invalide → défaut */ }
  }

  let retryDelays = [1000, 3000, 5000];
  if (env.ODOO_RETRY_DELAYS_MS) {
    try {
      const a = JSON.parse(env.ODOO_RETRY_DELAYS_MS);
      if (Array.isArray(a) && a.every((n) => Number.isFinite(n))) retryDelays = a;
    } catch { /* JSON invalide → défaut */ }
  }

  return {
    secretsPath,
    odooCreds,
    // YOLO + method calls : défaut ACTIVÉ (comportement historique — requis
    // pour call_model_method). Opt-out explicite `ODOO_PROXY_YOLO=false` :
    // le backend retrouve alors SA couche d'access control (déploiement
    // public prudent — le template plugin passe false par défaut).
    yolo: env.ODOO_PROXY_YOLO !== "false",
    backendCmd,
    retryDelays,
    cwd: baseDir,
    initTimeoutMs: 15000,
    callTimeoutMs: 120000,
  };
}
