// Tests lib/config.js — PUR (zéro spawn). Runner = vitest (mutation Stryker perTest).
// ⚠️ perTest : TOUT appel au code muté DOIT vivre DANS le callback d'un `it()`.
// Une const évaluée au chargement du module = mutant « statique » → faux survivant.
import { describe, it, expect } from "vitest";
import { loadProxyConfig } from "./config.js";

const BASE = "/repo";

describe("loadProxyConfig — défauts (env vide)", () => {
  it("secretsPath défaut = ../infra-mcp/.secrets.json relatif au baseDir", () => {
    expect(loadProxyConfig({}, BASE).secretsPath.replace(/\\/g, "/")).toMatch(/\/infra-mcp\/\.secrets\.json$/);
  });
  it("backendCmd défaut = python -m mcp_server_odoo", () => {
    const c = loadProxyConfig({}, BASE);
    expect(c.backendCmd[0]).toBe("python");
    expect(c.backendCmd).toContain("mcp_server_odoo");
  });
  it("backendCmd défaut transport stdio", () => {
    expect(loadProxyConfig({}, BASE).backendCmd.join(" ")).toContain("--transport stdio");
  });
  it("retryDelays défaut 1s/3s/5s", () => {
    expect(loadProxyConfig({}, BASE).retryDelays).toEqual([1000, 3000, 5000]);
  });
  it("cwd = baseDir", () => {
    expect(loadProxyConfig({}, BASE).cwd).toBe(BASE);
  });
  it("timeouts par défaut", () => {
    const c = loadProxyConfig({}, BASE);
    expect(c.initTimeoutMs).toBe(15000);
    expect(c.callTimeoutMs).toBe(120000);
  });
});

describe("loadProxyConfig — overrides valides", () => {
  // (path.resolve normalise selon l'OS — sous Windows ajoute la lettre de lecteur.
  //  Ce qui compte : l'override est pris ET on n'utilise PAS le défaut infra-mcp.)
  const env = () => ({
    ODOO_SECRETS_PATH: "/abs/secrets.json",
    ODOO_PYTHON: "python3",
    ODOO_RETRY_DELAYS_MS: "[10,20]",
  });

  it("ODOO_SECRETS_PATH absolu respecté", () => {
    const c = loadProxyConfig(env(), BASE);
    expect(c.secretsPath.replace(/\\/g, "/")).toMatch(/abs\/secrets\.json$/);
    expect(c.secretsPath).not.toContain("infra-mcp");
  });
  it("ODOO_PYTHON injecté dans backendCmd", () => {
    expect(loadProxyConfig(env(), BASE).backendCmd[0]).toBe("python3");
  });
  it("ODOO_RETRY_DELAYS_MS parsé", () => {
    expect(loadProxyConfig(env(), BASE).retryDelays).toEqual([10, 20]);
  });
  it("ODOO_BACKEND_CMD JSON array respecté", () => {
    expect(loadProxyConfig({ ODOO_BACKEND_CMD: '["node","fake.js"]' }, BASE).backendCmd).toEqual(["node", "fake.js"]);
  });
});

describe("loadProxyConfig — fallbacks (JSON invalide / formes interdites, jamais de throw)", () => {
  it("ODOO_BACKEND_CMD JSON cassé → défaut python", () => {
    expect(loadProxyConfig({ ODOO_BACKEND_CMD: "{pas json" }, BASE).backendCmd[0]).toBe("python");
  });
  it("ODOO_BACKEND_CMD array vide → défaut", () => {
    expect(loadProxyConfig({ ODOO_BACKEND_CMD: "[]" }, BASE).backendCmd).toContain("mcp_server_odoo");
  });
  it("ODOO_BACKEND_CMD non-array → défaut", () => {
    expect(loadProxyConfig({ ODOO_BACKEND_CMD: '"x"' }, BASE).backendCmd[0]).toBe("python");
  });
  it("ODOO_RETRY_DELAYS_MS cassé → défaut", () => {
    expect(loadProxyConfig({ ODOO_RETRY_DELAYS_MS: "nope" }, BASE).retryDelays).toEqual([1000, 3000, 5000]);
  });
  it("ODOO_RETRY_DELAYS_MS avec non-nombre → défaut (every Number.isFinite)", () => {
    expect(loadProxyConfig({ ODOO_RETRY_DELAYS_MS: '[1,"x"]' }, BASE).retryDelays).toEqual([1000, 3000, 5000]);
  });
  it("ODOO_RETRY_DELAYS_MS non-array → défaut", () => {
    expect(loadProxyConfig({ ODOO_RETRY_DELAYS_MS: "5" }, BASE).retryDelays).toEqual([1000, 3000, 5000]);
  });
});

describe("loadProxyConfig — creds Odoo par ENV (portables, prioritaires sur le fichier)", () => {
  it("creds env complètes (user/password) → odooCreds EXACT", () => {
    const c = loadProxyConfig({ ODOO_URL: "https://x.odoo.com", ODOO_DB: "prod", ODOO_USER: "bot", ODOO_PASSWORD: "pw" }, BASE);
    expect(c.odooCreds).toEqual({ url: "https://x.odoo.com", db: "prod", login: "bot", password: "pw", apiKey: null });
  });
  it("alias ODOO_LOGIN accepté", () => {
    const c = loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d", ODOO_LOGIN: "bot2", ODOO_PASSWORD: "pw" }, BASE);
    expect(c.odooCreds).toBeTruthy();
    expect(c.odooCreds.login).toBe("bot2");
  });
  it("api key SANS login/password suffit", () => {
    const c = loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d", ODOO_API_KEY: "k123" }, BASE);
    expect(c.odooCreds).toBeTruthy();
    expect(c.odooCreds.apiKey).toBe("k123");
    expect(c.odooCreds.login).toBe(null);
  });
  it("creds incomplètes → null (fichier secrets utilisé)", () => {
    expect(loadProxyConfig({}, BASE).odooCreds).toBe(null);
    expect(loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d" }, BASE).odooCreds).toBe(null);
    expect(loadProxyConfig({ ODOO_URL: "https://x", ODOO_DB: "d", ODOO_USER: "u" }, BASE).odooCreds).toBe(null);
    expect(loadProxyConfig({ ODOO_URL: "https://x", ODOO_USER: "u", ODOO_PASSWORD: "p" }, BASE).odooCreds).toBe(null);
  });
  it("valeur vide = absente (pas de creds fantômes)", () => {
    expect(loadProxyConfig({ ODOO_URL: "", ODOO_DB: "d", ODOO_USER: "u", ODOO_PASSWORD: "p" }, BASE).odooCreds).toBe(null);
  });
});

describe("loadProxyConfig — YOLO opt-out", () => {
  it("yolo défaut = true (comportement historique)", () => {
    expect(loadProxyConfig({}, BASE).yolo).toBe(true);
  });
  it("ODOO_PROXY_YOLO=false → yolo false", () => {
    expect(loadProxyConfig({ ODOO_PROXY_YOLO: "false" }, BASE).yolo).toBe(false);
  });
  it("ODOO_PROXY_YOLO=true / autre valeur → yolo true", () => {
    expect(loadProxyConfig({ ODOO_PROXY_YOLO: "true" }, BASE).yolo).toBe(true);
    expect(loadProxyConfig({ ODOO_PROXY_YOLO: "0" }, BASE).yolo).toBe(true);
  });
});
