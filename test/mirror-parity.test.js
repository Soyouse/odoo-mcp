// ═══════════════════════════════════════════════════════════════════════
// GATE DE PARITÉ AVEC LE MIROIR PUBLIC — fails-closed, tourne au pre-push.
// ═══════════════════════════════════════════════════════════════════════
//
// POURQUOI (classe payée DEUX FOIS le 2026-08-20) : la publication est un
// `git archive HEAD | tar -x -C ../odoo-mcp-public` MANUEL. Il ÉCRASE les
// fichiers suivis et ne SUPPRIME jamais ce qui n'existe que dans le miroir.
// Conséquence vécue : ① le portage vitest fait dans le miroir aurait été
// écrasé au prochain export ; ② les gates de couplage posées dans le miroir
// n'existaient pas ici et auraient été retirées du package.json publié.
// Aucune de ces deux dérives n'a laissé la moindre trace — d'où ce gate.
//
// ⚠️ NE JAMAIS transformer un ROUGE d'ici en exemption de confort : le volet 2
//    déclare la divergence VOULUE, il ne l'absout pas. Une entrée ajoutée sans
//    raison écrite est une régression, pas une correction.
// ⚠️ Comparaison par BLOB GIT (`git hash-object`), JAMAIS par octets bruts :
//    les deux copies de travail diffèrent légitimement en fins de ligne
//    (`* text=auto` + checkout Windows d'un côté, sortie LF de `git archive`
//    de l'autre). Une comparaison brute rougirait sur 17 fichiers identiques
//    — MESURÉ le 2026-08-20.
// ⚠️ L'adresse du miroir est MESURÉE, jamais supposée : dossier frère candidat
//    + VÉRIFICATION de son remote `origin` contre l'URL publique déclarée dans
//    package.json. Un dossier homonyme au mauvais remote = ROUGE, pas un vert.

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// ── Volet 2 : divergences VOULUES, déclarées avec leur raison ──
// PHOTO MESURÉE le 2026-08-20 après ré-export : le miroir ne contient AUCUN
// fichier suivi absent d'ici. La liste vide est donc l'état RÉEL, pas un oubli
// — et c'est l'état CIBLE : tout ce qui est publié doit venir de la source.
// Format : { "chemin/relatif": "raison écrite, pas un TODO" }
const MIRROR_ONLY_DECLARED = {};

// `docs/` ne part JAMAIS à l'export (données internes) — cf docs/repos-architecture.md.
const NEVER_EXPORTED = (rel) => rel === "docs" || rel.startsWith("docs/");

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const ROOT = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();

// Chemins suivis, en une seule mesure.
const tracked = (dir) => git(dir, ["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);

// Hash git des fichiers PRÉSENTS sur le disque (normalisation .gitattributes
// du dépôt concerné), en un seul spawn.
function hashAll(dir, files) {
  if (files.length === 0) return new Map();
  const out = git(dir, ["hash-object", "--", ...files]).split("\n").map((s) => s.trim()).filter(Boolean);
  return new Map(files.map((f, i) => [f, out[i]]));
}

// ── Adresse du miroir : mesurée, puis PROUVÉE par son remote ──
function locateMirror() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const expected = String(pkg.repository?.url || "").replace(/\.git$/, "");
  const candidate = path.join(path.dirname(ROOT), `${path.basename(ROOT)}-public`);
  if (!expected) return { status: "no-url" };
  if (!fs.existsSync(path.join(candidate, ".git"))) return { status: "absent", candidate };
  let origin;
  try { origin = git(candidate, ["remote", "get-url", "origin"]).trim().replace(/\.git$/, ""); }
  catch { return { status: "no-remote", candidate }; }
  return origin === expected
    ? { status: "ok", dir: candidate, origin }
    : { status: "wrong-remote", candidate, origin, expected };
}

const mirror = locateMirror();
const REPLAY = [
  "  ⇒ RÉPARER : rejoue l'export documenté (docs/repos-architecture.md §Publier) —",
  "     git archive HEAD | tar -x -C ../odoo-mcp-public && rm -r ../odoo-mcp-public/docs",
  "     puis commit + push DANS LE MIROIR.",
  "  ⇒ Si la divergence est VOULUE côté miroir : déclare le fichier dans",
  "     MIRROR_ONLY_DECLARED (test/mirror-parity.test.js) avec sa raison écrite.",
].join("\n");

describe("parité avec le miroir public (le publié doit venir de la source)", () => {
  // Le miroir n'existe pas chez un contributeur ni dans la CI publique : on
  // SKIPPE, mais NOMMÉMENT (un skip muet serait indiscernable d'un gate mort).
  if (mirror.status === "absent") {
    it.skip(`SKIP NOMMÉ — miroir introuvable en ${mirror.candidate} (clone externe ou CI publique : normal)`, () => {});
    return;
  }

  it("le miroir candidat EST bien le dépôt public (remote vérifié, jamais supposé)", () => {
    expect(mirror.status, `Miroir ambigu en ${mirror.candidate} — status=${mirror.status}` +
      (mirror.origin ? ` origin=${mirror.origin} attendu=${mirror.expected}` : "") +
      "\n  ⇒ RÉPARER : ce dossier n'est pas le miroir public. Ne compare rien tant que" +
      " l'adresse n'est pas prouvée (renomme/supprime l'homonyme, ou corrige son remote).").toBe("ok");
  });

  it("volet 1 — tout fichier suivi ici (hors docs/) existe à l'IDENTIQUE dans le miroir", () => {
    const mine = tracked(ROOT).filter((f) => !NEVER_EXPORTED(f));
    const hereHashes = hashAll(ROOT, mine);
    const missing = mine.filter((f) => !fs.existsSync(path.join(mirror.dir, f)));
    const present = mine.filter((f) => fs.existsSync(path.join(mirror.dir, f)));
    const theirHashes = hashAll(mirror.dir, present);
    const differing = present.filter((f) => hereHashes.get(f) !== theirHashes.get(f));

    const faults = [
      ...missing.map((f) => `  ABSENT DU MIROIR : ${f}`),
      ...differing.map((f) => `  CONTENU DIVERGENT : ${f}`),
    ];
    expect(faults.join("\n") && `PARITÉ MIROIR ROMPUE (${faults.length} fichier(s)) :\n${faults.join("\n")}\n${REPLAY}`)
      .toBe("");
  });

  it("volet 2 — tout fichier suivi UNIQUEMENT dans le miroir est DÉCLARÉ avec sa raison", () => {
    const mine = new Set(tracked(ROOT));
    const undeclared = tracked(mirror.dir)
      .filter((f) => !mine.has(f))
      .filter((f) => !Object.prototype.hasOwnProperty.call(MIRROR_ONLY_DECLARED, f));

    expect(undeclared.length && `FICHIER(S) MIROIR-SEUL NON DÉCLARÉ(S) (${undeclared.length}) :\n` +
      undeclared.map((f) => `  ${f}`).join("\n") +
      "\n  ⇒ RÉPARER : soit le fichier appartient à la source et il faut le RAPATRIER ici" +
      " (puis rejouer l'export), soit la divergence est voulue et il se DÉCLARE dans" +
      " MIRROR_ONLY_DECLARED avec sa raison.\n" + REPLAY).toBe(0);
  });

  it("volet 3 — anti-sonde-muette : un périmètre vide serait indiscernable d'une parité parfaite", () => {
    const compared = tracked(ROOT).filter((f) => !NEVER_EXPORTED(f)).length;
    expect(compared, "ZÉRO fichier comparé : le gate ne prouve RIEN (chemin mort, ls-files vide)." +
      "\n  ⇒ RÉPARER : vérifier que le test tourne bien à la racine du dépôt suivi.").toBeGreaterThan(0);
  });
});
