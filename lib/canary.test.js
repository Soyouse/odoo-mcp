// Tests lib/canary.js — tuyau I/O du canary NTFY, AUCUN réseau ni fichier réel
// (read/fetch injectés). Prouve : ping tenté avec la bonne requête, fail-silent
// total (fichier illisible, conf incomplète, réseau mort), jamais de rejet non géré.
// Runner = vitest. ⚠️ canary.js est de l'I/O : NON muté (cf stryker.conf.json).
import { describe, it, expect } from "vitest";
import { fireCanary } from "./canary.js";
import { parseEnvText, canaryRequest } from "./readback.js";

const PURE = () => ({ parseEnvText, canaryRequest });
const ENV = "NTFY_URL=https://ntfy.example.com\nNTFY_TOPIC=acme-alerts\nNTFY_USER=admin\nNTFY_PASS=pw\n";

describe("fireCanary — chemin nominal", () => {
  // env lu, requête construite, fetch appelé — sans attendre.
  const fire = () => {
    const sent = [];
    const r = fireCanary(
      { ...PURE(), envPath: "/fake.env", readFileSync: () => ENV, fetchImpl: (url, opts) => { sent.push({ url, opts }); return Promise.resolve({ ok: true }); } },
      "Garde Odoo MCP declenchee", "🛑 GARDE ANTI-DOUBLON : envoi BLOQUÉ",
    );
    return { r, sent };
  };

  it("nominal: ping tenté → true", () => {
    expect(fire().r).toBe(true);
  });
  it("nominal: POST vers NTFY_URL/topic", () => {
    const { sent } = fire();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://ntfy.example.com/acme-alerts");
    expect(sent[0].opts.method).toBe("POST");
  });
  it("nominal: titre + corps transmis", () => {
    const { sent } = fire();
    expect(sent[0].opts.headers.Title).toBe("Garde Odoo MCP declenchee");
    expect(sent[0].opts.body).toContain("ANTI-DOUBLON");
  });
});

describe("fireCanary — fail-silent total", () => {
  it("secrets illisibles → false, zéro fetch, zéro throw", () => {
    let fetched = false;
    const r = fireCanary({ ...PURE(), envPath: "/fake.env", readFileSync: () => { throw new Error("ENOENT"); }, fetchImpl: () => { fetched = true; } }, "T", "m");
    expect(r).toBe(false);
    expect(fetched).toBe(false);
  });
  it("conf incomplète → false, zéro fetch", () => {
    let fetched = false;
    const r = fireCanary({ ...PURE(), envPath: "/fake.env", readFileSync: () => "NTFY_URL=https://x\n", fetchImpl: () => { fetched = true; } }, "T", "m");
    expect(r).toBe(false);
    expect(fetched).toBe(false);
  });
  it("fetch rejeté → true (tenté) + rejet absorbé", async () => {
    // Réseau mort (fetch rejette) → true (tenté) et le rejet est ABSORBÉ
    // (un unhandledRejection ferait échouer ce process de test).
    let rejected = false;
    const onRejection = () => { rejected = true; };
    process.once("unhandledRejection", onRejection);
    const r = fireCanary({ ...PURE(), envPath: "/fake.env", readFileSync: () => ENV, fetchImpl: () => Promise.reject(new Error("réseau mort")) }, "T", "m");
    await new Promise((res) => setTimeout(res, 20));
    process.off("unhandledRejection", onRejection);
    expect(r).toBe(true);
    expect(rejected).toBe(false);
  });
  it("fetch throw synchrone → false, zéro throw", () => {
    // fetch qui THROW en synchrone (ex. header invalide) → catché, false.
    const r = fireCanary({ ...PURE(), envPath: "/fake.env", readFileSync: () => ENV, fetchImpl: () => { throw new Error("bad header"); } }, "T", "m");
    expect(r).toBe(false);
  });
});
