// ═══════════════════════════════════════════════════════════════════════
// lib/validate.js — Validation PRÉCOCE des appels odoo_call (anti-freeze).
// ═══════════════════════════════════════════════════════════════════════
//
// PROBLÈME RÉSOLU (backlog T-03) : un appel mal formé (mauvais type d'args,
// nom d'outil inexistant) était transmis au backend Python → erreur TARDIVE
// + latence perçue comme un freeze. On valide ICI, AVANT tout I/O réseau, et
// on renvoie une erreur IMMÉDIATE et EXPLICITE.
//
// ⚠️ FONCTION PURE : aucun I/O, aucun effet de bord, aucune dépendance au
//   process/transport → unit-testable sans stdio. NE PAS y mettre de spawn,
//   de lecture fichier, ni de require de proxy.js (sinon boucle/effet de bord).
// ⚠️ Renvoie { error: string } si invalide, ou null si OK. JAMAIS de throw
//   (le proxy ne doit jamais crasher — il mappe { error } en content text).
//
// `knownToolNames` (optionnel) : liste des outils backend si le cache est déjà
//   chaud. Si absent (backend pas encore interrogé), on NE bloque PAS sur le
//   nom (on ne peut pas savoir) → fail-open sur l'existence, strict sur la forme.

// Suggestion "did you mean" : noms connus partageant un préfixe/substring.
export function suggest(toolName, knownToolNames) {
  if (!Array.isArray(knownToolNames) || knownToolNames.length === 0) return [];
  const low = String(toolName).toLowerCase();
  const hits = knownToolNames.filter((n) => {
    const ln = n.toLowerCase();
    return ln.includes(low) || low.includes(ln);
  });
  return hits.slice(0, 5);
}

// Valide la forme d'un appel odoo_call. Retourne null si OK, sinon { error }.
export function validateCall(toolName, callArgs, knownToolNames) {
  // 1. tool : chaîne non vide OBLIGATOIRE.
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    return { error: "Error: 'tool' parameter is required and must be a non-empty string. Call odoo_discover to list available tools." };
  }

  // 2. args : objet simple si fourni (ni string, ni tableau, ni null explicite).
  //    undefined est toléré (= pas d'args) ; le proxy le remplace par {}.
  if (callArgs !== undefined) {
    if (callArgs === null || typeof callArgs !== 'object' || Array.isArray(callArgs)) {
      return { error: `Error: 'args' must be an object (got ${Array.isArray(callArgs) ? 'array' : typeof callArgs}). Example: { "model": "res.partner", "domain": [["id","=",1]] }.` };
    }
  }

  // 3. nom d'outil : validé SEULEMENT si le cache des outils est connu.
  if (Array.isArray(knownToolNames) && knownToolNames.length > 0 && !knownToolNames.includes(toolName)) {
    const hints = suggest(toolName, knownToolNames);
    const tail = hints.length ? ` Did you mean: ${hints.join(', ')}?` : ' Call odoo_discover to list available tools.';
    return { error: `Error: unknown tool '${toolName}'.${tail}` };
  }

  return null;
}
