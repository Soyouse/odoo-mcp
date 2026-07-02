// Tests lib/config.js — PUR (zéro spawn). Harness Node natif, zéro dep.
import { loadProxyConfig } from "./config.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("lib/config.test.js\n");

const BASE = "/repo";

// ── Défauts (env vide) ──
{
  const c = loadProxyConfig({}, BASE);
  ok("secretsPath défaut = ../infra-mcp/.secrets.json relatif au baseDir", c.secretsPath.replace(/\\/g, "/").endsWith("/infra-mcp/.secrets.json"));
  ok("backendCmd défaut = python -m mcp_server_odoo", c.backendCmd[0] === "python" && c.backendCmd.includes("mcp_server_odoo"));
  ok("backendCmd défaut transport stdio", c.backendCmd.join(" ").includes("--transport stdio"));
  ok("retryDelays défaut 1s/3s/5s", JSON.stringify(c.retryDelays) === JSON.stringify([1000, 3000, 5000]));
  ok("cwd = baseDir", c.cwd === BASE);
  ok("timeouts par défaut", c.initTimeoutMs === 15000 && c.callTimeoutMs === 120000);
}

// ── Overrides valides ──
{
  const c = loadProxyConfig({
    ODOO_SECRETS_PATH: "/abs/secrets.json",
    ODOO_PYTHON: "python3",
    ODOO_RETRY_DELAYS_MS: "[10,20]",
  }, BASE);
  // (path.resolve normalise selon l'OS — sous Windows ajoute la lettre de lecteur.
  //  Ce qui compte : l'override est pris ET on n'utilise PAS le défaut infra-mcp.)
  ok("ODOO_SECRETS_PATH absolu respecté", c.secretsPath.replace(/\\/g, "/").endsWith("abs/secrets.json") && !c.secretsPath.includes("infra-mcp"));
  ok("ODOO_PYTHON injecté dans backendCmd", c.backendCmd[0] === "python3");
  ok("ODOO_RETRY_DELAYS_MS parsé", JSON.stringify(c.retryDelays) === JSON.stringify([10, 20]));
}

// ── ODOO_BACKEND_CMD (injection faux backend) ──
{
  const c = loadProxyConfig({ ODOO_BACKEND_CMD: '["node","fake.js"]' }, BASE);
  ok("ODOO_BACKEND_CMD JSON array respecté", JSON.stringify(c.backendCmd) === JSON.stringify(["node", "fake.js"]));
}

// ── Fallbacks sur JSON invalide / formes interdites (jamais de throw) ──
{
  ok("ODOO_BACKEND_CMD JSON cassé → défaut python", loadProxyConfig({ ODOO_BACKEND_CMD: "{pas json" }, BASE).backendCmd[0] === "python");
  ok("ODOO_BACKEND_CMD array vide → défaut", loadProxyConfig({ ODOO_BACKEND_CMD: "[]" }, BASE).backendCmd.includes("mcp_server_odoo"));
  ok("ODOO_BACKEND_CMD non-array → défaut", loadProxyConfig({ ODOO_BACKEND_CMD: '"x"' }, BASE).backendCmd[0] === "python");
  ok("ODOO_RETRY_DELAYS_MS cassé → défaut", JSON.stringify(loadProxyConfig({ ODOO_RETRY_DELAYS_MS: "nope" }, BASE).retryDelays) === JSON.stringify([1000, 3000, 5000]));
  ok("ODOO_RETRY_DELAYS_MS avec non-nombre → défaut (every Number.isFinite)", JSON.stringify(loadProxyConfig({ ODOO_RETRY_DELAYS_MS: '[1,"x"]' }, BASE).retryDelays) === JSON.stringify([1000, 3000, 5000]));
  ok("ODOO_RETRY_DELAYS_MS non-array → défaut", JSON.stringify(loadProxyConfig({ ODOO_RETRY_DELAYS_MS: "5" }, BASE).retryDelays) === JSON.stringify([1000, 3000, 5000]));
}

// ── Creds Odoo par ENV (portable, prioritaires sur le fichier) ──
{
  const c = loadProxyConfig({ ODOO_URL: "https://x.odoo.com", ODOO_DB: "prod", ODOO_USER: "bot", ODOO_PASSWORD: "pw" }, BASE);
  ok("creds env complètes (user/password) → odooCreds EXACT",
    JSON.stringify(c.odooCreds) === JSON.stringify({ url: "https://x.odoo.com", db: "prod", login: "bot", password: "pw", apiKey: null }));
}
{
  const c = loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d", ODOO_LOGIN: "bot2", ODOO_PASSWORD: "pw" }, BASE);
  ok("alias ODOO_LOGIN accepté", c.odooCreds && c.odooCreds.login === "bot2");
}
{
  const c = loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d", ODOO_API_KEY: "k123" }, BASE);
  ok("api key SANS login/password suffit", c.odooCreds && c.odooCreds.apiKey === "k123" && c.odooCreds.login === null);
}
ok("creds incomplètes → null (fichier secrets utilisé)",
  loadProxyConfig({}, BASE).odooCreds === null &&
  loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d" }, BASE).odooCreds === null &&
  loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d", ODOO_USER: "u" }, BASE).odooCreds === null &&
  loadProxyConfig({ ODOO_URL: "https://x", ODOO_USER: "u", ODOO_PASSWORD: "p" }, BASE).odooCreds === null);
ok("valeur vide = absente (pas de creds fantômes)",
  loadProxyConfig({ ODOO_URL: "", ODOO_DB: "d", ODOO_USER: "u", ODOO_PASSWORD: "p" }, BASE).odooCreds === null);

// ── YOLO opt-out ──
ok("yolo défaut = true (comportement historique)", loadProxyConfig({}, BASE).yolo === true);
ok("ODOO_PROXY_YOLO=false → yolo false", loadProxyConfig({ ODOO_PROXY_YOLO: "false" }, BASE).yolo === false);
ok("ODOO_PROXY_YOLO=true / autre valeur → yolo true",
  loadProxyConfig({ ODOO_PROXY_YOLO: "true" }, BASE).yolo === true &&
  loadProxyConfig({ ODOO_PROXY_YOLO: "0" }, BASE).yolo === true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
