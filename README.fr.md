# odoo-mcp — MCP Odoo avec garde-fous pour Claude Code

*[English version: [README.md](README.md)]*

Un serveur MCP qui permet à Claude (ou tout client MCP) d'opérer un CRM/ERP [Odoo](https://www.odoo.com) — **avec des garde-fous pensés pour du vrai argent et de vrais clients**.

L'API XML-RPC d'Odoo est *aveugle* : les méthodes métier retournent souvent `null` tout en créant des factures et en envoyant des emails à vos clients, silencieusement. Un agent IA qui pilote cette API finira par envoyer un email de facture en double — le nôtre l'a fait. Ce proxy existe pour que cette classe d'incident ne puisse plus se produire, chez personne.

## Ce qu'il ajoute au-dessus d'un MCP Odoo brut

- **Relecture post-écriture (« MCP voyant »)** — après chaque écriture réussie, le proxy relit les enregistrements touchés et ajoute leur état *réel* en base au résultat. Ne jamais croire le retour d'une méthode ; toujours relire.
- **Garde anti-doublon d'envoi (fail-closed)** — renvoyer une facture déjà `is_move_sent=true` est **bloqué** avant d'atteindre Odoo. État invérifiable = bloqué aussi. Override explicite : `force_resend: true`.
- **Garde anti-double-facturation (fail-closed)** — relancer la facturation d'un abonnement déjà facturé ce mois-ci est **bloqué** (une 2ᵉ créance est pire qu'un 2ᵉ email). Override : `force_create: true`.
- **Scan des emails silencieux** — chaque écriture est encadrée d'un snapshot/diff de `mail.message` : tout email parti vers un destinataire *pendant* l'appel est remonté (`📧`), sinon certitude positive « aucun destinataire notifié ».
- **Pièges connus dans le tuyau** — l'avertissement (ex. `generate_invoice` peut créer *et envoyer* l'email dans la même transaction) est ajouté au résultat au moment exact de l'appel.
- **Capability detection** — les champs relus = souhaités ∩ réels du serveur (introspection) : compatible Odoo 17/18, dégradation propre si un module manque.
- **Hook de provenance des IDs (anti-hallucination)** — les IDs Odoo sont des entiers séquentiels courts ; un ID halluciné touche souvent un *vrai* enregistrement. Le hook Claude Code fourni bloque toute mutation sur un ID jamais retourné par une lecture *dans cette session*.
- **Canary NTFY optionnel** — chaque déclenchement de garde peut pinger un topic [ntfy](https://ntfy.sh).
- **Proxy never-crash** — spawn lazy, retries, hot-reload de la logique métier.

## Installation (plugin Claude Code)

```
/plugin marketplace add Soyouse/odoo-mcp
/plugin install odoo-mcp@soyouse
```

Prérequis : Node ≥ 20 et Python ≥ 3.10 avec le backend :

```
pip install mcp-server-odoo==0.6.0
```

## Configuration (variables d'environnement)

Voir le tableau du [README.md](README.md) : `ODOO_URL`, `ODOO_DB`, `ODOO_USER`/`ODOO_LOGIN` + `ODOO_PASSWORD` (ou `ODOO_API_KEY`), `ODOO_PROXY_YOLO` (défaut `false` en plugin — lire la note sécurité), `ODOO_PYTHON`, `ODOO_CANARY_ENV`.

## Modèle de sécurité

Avec `ODOO_PROXY_YOLO=true`, le backend Python court-circuite sa couche d'access control et enregistre `call_model_method` (l'`execute_kw` brut — seul moyen d'exécuter des méthodes métier). Les protections sont alors : (1) les droits de l'utilisateur Odoo (dédié, moindre privilège), (2) les gardes de ce proxy, (3) le hook de provenance. Défaut = **désactivé**.

## Développement

```
npm test           # 8 suites, zéro réseau, faux backend stdio
npm run mutation   # Stryker sur la logique pure (cliquet break 85)
```

MIT © Soyouse
