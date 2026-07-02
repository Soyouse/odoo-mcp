// ═══════════════════════════════════════════════════════════════════════
// lib/fields.js — Découverte de champs sur erreur "Invalid field" (T-04).
// ═══════════════════════════════════════════════════════════════════════
//
// PROBLÈME RÉSOLU (backlog T-04) : demander un champ absent d'un modèle plante
// avec « Invalid field 'X' » SANS lister les champs valides. La découverte
// officielle passe par une RESOURCE (`odoo://<model>/fields`) que le proxy ne
// forwarde pas → injoignable. Parade : sur cette erreur précise, le proxy
// récupère les champs via `fields_get` et les AJOUTE au message → auto-correction.
//
// ⚠️ FONCTIONS PURES : aucun I/O. L'appel réseau `fields_get` est fait par le
//   proxy ; ici on ne fait que détecter / parser / formater. JAMAIS de throw.

// Détecte une erreur "Invalid field 'X'" → renvoie le nom du champ, sinon null.
export function parseInvalidField(message) {
  if (typeof message !== 'string') return null;
  const m = message.match(/invalid field ['"]?([\w.]+)['"]?/i);
  return m ? m[1] : null;
}

// Extrait les noms de champs depuis la sortie d'une découverte de champs.
// MESURÉ LIVE (backend 0.6.0) : la resource `odoo://<model>/fields` renvoie un
// TEXTE humain (pas du JSON) — chaque champ = une ligne `nom_champ:` en colonne 0,
// suivie de lignes indentées (Label/Required/...). On supporte 3 formes par
// robustesse : JSON {result:{field:{}}}, ce format texte, et pretty-JSON.
// Renvoie un tableau (vide si rien trouvé). JAMAIS de throw.
export function extractFieldNames(text) {
  if (typeof text !== 'string' || !text) return [];
  // 1) JSON { result: { <field>: {...} } }.
  try {
    const obj = JSON.parse(text);
    const result = obj && obj.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return Object.keys(result);
    }
  } catch { /* pas du JSON → formes texte ci-dessous */ }
  // 2) Format resource Odoo : `nom_champ:` seul, en début de ligne. Les en-têtes
  //    de section (« BINARY Fields (10): », « Field Definitions: x », « Total
  //    fields: 201 ») contiennent espace/majuscule/contenu après `:` → exclus
  //    par l'ancre col-0 + minuscule + fin-de-ligne immédiate.
  const lineNames = [];
  const lineRe = /^([a-z_][\w]*):[ \t]*$/gm;
  let lm;
  while ((lm = lineRe.exec(text)) !== null) lineNames.push(lm[1]);
  if (lineNames.length) return lineNames;
  // 3) Fallback : pretty-JSON `"field": { "type"`.
  const names = [];
  const re = /"([\w.]+)"\s*:\s*\{\s*"type"/g;
  let m;
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
}

// Champs "proches" du champ fautif : partagent un token (split sur _) ou substring.
export function closeFields(badField, names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const tokens = String(badField).toLowerCase().split(/[._]/).filter(Boolean);
  const low = String(badField).toLowerCase();
  const scored = names.filter((n) => {
    const ln = n.toLowerCase();
    if (ln.includes(low) || low.includes(ln)) return true;
    return tokens.some((t) => t.length >= 3 && ln.includes(t));
  });
  return scored.slice(0, 10);
}

// Construit le message enrichi : champ fautif + suggestions + liste complète.
export function formatFieldHint(model, badField, names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const near = closeFields(badField, names);
  const sorted = [...names].sort();
  const nearLine = near.length ? `\nProbablement voulu : ${near.join(', ')}.` : '';
  return (
    `Error: Invalid field '${badField}' on model '${model}'.${nearLine}\n` +
    `Champs valides (${sorted.length}) : ${sorted.join(', ')}.`
  );
}
