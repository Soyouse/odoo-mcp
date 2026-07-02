/**
 * Lazy Proxy MCP pour Odoo CRM — SHELL MINCE.
 *
 *   Claude <--stdio--> PROXY (2 meta-outils) <--subprocess/stdio--> mcp-server-odoo (Python)
 *
 * ⚠️ CE FICHIER EST UN SHELL STABLE : transport + wiring uniquement, ZÉRO logique
 *   métier. Toute feature (validation, enrichissement, formatage) vit DERRIÈRE,
 *   dans lib/handlers.js (+ lib/validate.js, lib/fields.js). RÈGLE : ajouter une
 *   feature NE DOIT PAS toucher proxy.js. Si tu dois l'éditer pour une feature,
 *   c'est que la logique a re-fui dans le shell → la remettre dans lib/.
 *
 * ⚠️ HOT-RELOAD DU CODE MÉTIER : les handlers (sans état) sont ré-importés à
 *   CHAQUE appel si leur mtime a changé (cache-bust ?v=). → éditer lib/handlers
 *   /validate/fields part EN LIVE sans `/mcp reconnect`. Seul ce shell (rare) +
 *   lib/backend.js (transport, stateful) exigent un reconnect car ils portent
 *   l'état vivant (connexion). C'est le hot-reload qu'on visait : on en profite
 *   enfin pour 95% des modifs.
 *
 * ⚠️ INVARIANT never-crash : aucun handler ne throw → toujours un content text
 *   "Error: ...". Un throw = /mcp reconnect forcé côté Claude Code.
 *
 * Secrets / env / résilience : voir lib/config.js et lib/backend.js.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath, pathToFileURL } from "url";
import { statSync, readdirSync } from "fs";
import path from "path";
import { loadProxyConfig } from "./lib/config.js";
import { BackendMCP } from "./lib/backend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Transport : instancié UNE fois, porte l'état vivant (process backend). JAMAIS
// hot-reloadé (sinon perte de connexion). Config résolue depuis l'env du shell.
const backend = new BackendMCP(loadProxyConfig(process.env, __dirname));

// ─── Hot-loader du code métier (AUTO-DÉCOUVERTE) ───
// Tout `lib/*.js` est du code métier hot-reloadé, SAUF : `backend.js` (transport
// STATEFUL — le recharger = perdre la connexion), `config.js` (résolue une fois
// au boot par le shell) et `*.test.js`. Ajouter un module de logique = créer le
// fichier dans lib/, il est découvert au prochain appel — ZÉRO modif du shell,
// ZÉRO reconnect. Tous les exports des modules sont fusionnés dans `deps` et
// injectés à makeHandlers (⚠️ noms d'export UNIQUES entre modules — collision =
// écrasement silencieux, ordre alphabétique).
// La « version » = ensemble des fichiers + max mtime → création, édition ET
// suppression d'un module déclenchent le rechargement cohérent de TOUS.
const LOGIC_DIR = path.resolve(__dirname, "lib");
const NOT_LOGIC = new Set(["backend.js", "config.js"]);
let _handlers = null;
let _logicVersion = null;

function logicFiles() {
  try {
    return readdirSync(LOGIC_DIR)
      .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && !NOT_LOGIC.has(f))
      .sort()
      .map((f) => path.join(LOGIC_DIR, f));
  } catch { return []; }
}

function logicVersion(files) {
  let mtime = 0;
  for (const f of files) { try { mtime = Math.max(mtime, statSync(f).mtimeMs); } catch {} }
  return `${files.join("|")}::${mtime}`;
}

async function getHandlers() {
  const files = logicFiles();
  const v = logicVersion(files);
  if (_handlers && v === _logicVersion) return _handlers;
  const bust = `?v=${encodeURIComponent(v)}`;
  const mods = await Promise.all(files.map((f) => import(pathToFileURL(f).href + bust)));
  const deps = Object.assign({}, ...mods);
  if (typeof deps.makeHandlers !== "function") throw new Error("hot-loader: makeHandlers introuvable dans lib/ (handlers.js manquant ?)");
  _handlers = deps.makeHandlers(deps);
  _logicVersion = v;
  return _handlers;
}

// ─── Meta-tools (schéma STABLE, ne change pas avec les features) ───
const META_TOOLS = [
  {
    name: "odoo_discover",
    description: "List all available Odoo CRM tools (contacts, invoices, quotes, products, etc.). Call this first.",
    inputSchema: { "$schema": "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "odoo_call",
    description: "Execute an Odoo CRM tool by name. Use odoo_discover first to see available tools and parameters.",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        tool: { type: "string", description: "Tool name (e.g. 'search_records', 'create_record', 'execute_method')" },
        args: { type: "object", description: "Arguments for the tool", additionalProperties: true },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
];

const proxy = new Server({ name: "odoo-crm", version: "1.0.0" }, { capabilities: { tools: {} } });

proxy.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));

// Routage pur → délègue au code métier hot-rechargé. Le try/catch garantit le
// never-crash même si le hot-import échoue (ex. handlers édité avec une faute).
proxy.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const h = await getHandlers();
    if (name === "odoo_discover") return await h.handleDiscover(backend);
    if (name === "odoo_call") return await h.handleCall(backend, args);
    return { content: [{ type: "text", text: `Unknown meta-tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `Error (proxy): ${e.message}` }], isError: true };
  }
});

// Last resort : si quelque chose remonte jusqu'ici, on log mais on NE meurt PAS.
process.on("uncaughtException", (e) => {
  process.stderr.write(`[proxy] uncaughtException: ${e.stack || e.message}\n`);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[proxy] unhandledRejection: ${e?.stack || e?.message || e}\n`);
});

async function main() {
  const transport = new StdioServerTransport();
  await proxy.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`Proxy fatal: ${e.message}\n`);
  process.exit(1);
});
