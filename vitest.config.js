// Config vitest — runner du parc (seul runner avec un plugin Stryker perTest).
// ⚠️ `reporters` DÉCLARÉ ICI, jamais en CLI : `--reporter=basic` est DEPRECATED
//    (supprimé en vitest v4) et une option CLI enjambe cette config.
// ⚠️ `testTimeout: 30000` OBLIGATOIRE : test/proxy.test.js et
//    hooks/odoo-provenance.test.js SPAWNENT des process node (~1,5 s au
//    démarrage, bien plus sous charge) ; le défaut 5 s de vitest est calé sur
//    des tests EN MÉMOIRE et produit des rouges intermittents. C'est une BORNE,
//    elle n'allonge aucun test.
// ⚠️ test/contract.test.js EXCLU : il exige un Odoo RÉEL éphémère
//    (`npm run test:contract`, docker) — hors `npm test` par construction.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Périmètre DÉRIVÉ du disque (glob), jamais une liste de fichiers : un test
    // ajouté demain entre seul dans le filet. Seul contract.test.js est exclu.
    include: ["lib/**/*.test.js", "hooks/**/*.test.js", "test/**/*.test.js"],
    exclude: ["node_modules/**", ".stryker-tmp/**", "test/contract.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: [["default", { summary: false }]],
  },
});
