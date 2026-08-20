// Config vitest DÉDIÉE à la mutation — même périmètre que l'ancien
// commandRunner : les suites des fichiers MUTÉS (logique pure) + handlers
// (comportemental, tue les mutants d'orchestration de readback).
// ⚠️ EXCLUT test/proxy.test.js et hooks/odoo-provenance.test.js : ils SPAWNENT
//    des process → coût par mutant prohibitif, zéro mutant supplémentaire tué.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "lib/config.test.js",
      "lib/validate.test.js",
      "lib/fields.test.js",
      "lib/readback.test.js",
      "lib/handlers.test.js",
    ],
    exclude: ["node_modules/**", ".stryker-tmp/**"],
    testTimeout: 30000,
    reporters: [["default", { summary: false }]],
  },
});
