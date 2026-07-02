// ═══════════════════════════════════════════════════════════════════════
// lib/backend.js — Transport vers le backend Python (spawn + JSON-RPC stdio).
// ═══════════════════════════════════════════════════════════════════════
//
// C'est le SHELL/INFRA stable : il ne contient AUCUNE logique métier (pas de
// validation, pas d'enrichissement, pas de formatage) — uniquement le pont
// process ↔ JSON-RPC. Il NE change PAS quand on ajoute une feature.
//
// ⚠️ INVARIANT : aucune méthode ne doit laisser fuir une exception non maîtrisée
//   au-delà de l'appelant (le handler la catch et renvoie un content text).
// ⚠️ Config INJECTÉE (constructeur) — ce module ne lit ni process.env ni
//   __dirname → testable + réutilisable. Le shell (proxy.js) résout la config
//   (lib/config.js) et la passe ici.
// ⚠️ État (process spawné, pending, cache) = VIVANT entre les appels → cette
//   classe est instanciée UNE fois dans le shell, JAMAIS hot-reloadée (sinon on
//   perdrait la connexion backend). Seuls les handlers (sans état) sont hot.

import { spawn } from "child_process";
import { statSync, readFileSync } from "fs";
import readline from "readline";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BackendMCP {
  // config = { secretsPath, backendCmd, retryDelays, cwd, initTimeoutMs, callTimeoutMs }
  constructor(config) {
    this.config = config;
    this.process = null;
    this._idCounter = 0;
    this._toolsCache = null;
    this._resourceCache = new Map();
    this._pending = new Map();
    this._rl = null;
    this._lastMtime = 0;
    this._starting = null;
  }

  _loadOdooConfig() {
    // Creds résolues par lib/config.js depuis l'ENV (ODOO_URL/DB/USER/PASSWORD
    // ou ODOO_API_KEY) → prioritaires, le fichier secrets n'est jamais lu.
    if (this.config.odooCreds) return this.config.odooCreds;
    const raw = readFileSync(this.config.secretsPath, "utf8");
    const odoo = JSON.parse(raw)?.credentials?.odoo;
    if (!odoo?.url || !odoo?.db || !odoo?.login || !odoo?.password) {
      throw new Error(`credentials.odoo incomplet dans ${this.config.secretsPath}`);
    }
    return odoo;
  }

  // Hot-reload : on ne surveille QUE .secrets.json (nos creds). ⚠️ NE PAS
  // re-scanner les sources du backend : package pip ÉPINGLÉ qu'on n'édite
  // jamais → scanner l'arbre .py à chaque appel = gaspillage IO pur.
  _secretsMtime() {
    try { return statSync(this.config.secretsPath).mtimeMs; } catch { return 0; }
  }

  _isAlive() {
    return this.process && this.process.exitCode === null && !this.process.killed;
  }

  // Resilient ensure : retry avec backoff. Throw uniquement après épuisement.
  // L'appelant DOIT catcher → on ne laisse JAMAIS l'erreur remonter au handler MCP.
  async ensureRunning() {
    const mtime = this._secretsMtime();
    const stale = mtime !== this._lastMtime && this._lastMtime !== 0;
    const dead = !this._isAlive();

    if (!stale && !dead) return;

    if (this._starting) {
      try { await this._starting; return; } catch {}
    }

    const delays = this.config.retryDelays;
    let lastError;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        this._starting = this._start();
        await this._starting;
        this._lastMtime = mtime;
        return;
      } catch (e) {
        lastError = e;
        process.stderr.write(`[odoo] start attempt ${attempt + 1} failed: ${e.message}\n`);
        if (attempt < delays.length) await sleep(delays[attempt]);
      } finally {
        this._starting = null;
      }
    }
    throw new Error(`Backend unavailable after ${delays.length + 1} attempts: ${lastError?.message || "unknown"}`);
  }

  async _start() {
    if (this._isAlive()) {
      try { this.process.removeAllListeners("exit"); this.process.kill(); } catch {}
    }
    this._pending.clear();
    if (this._rl) { try { this._rl.close(); } catch {} this._rl = null; }
    this._toolsCache = null;
    this._resourceCache.clear();

    const odoo = this._loadOdooConfig();
    const cmd = this.config.backendCmd;
    const proc = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ODOO_URL: odoo.url,
        ODOO_DB: odoo.db,
        ...(odoo.login ? { ODOO_USER: odoo.login } : {}),
        ...(odoo.password ? { ODOO_PASSWORD: odoo.password } : {}),
        ...(odoo.apiKey ? { ODOO_API_KEY: odoo.apiKey } : {}),
        // ⚠️ YOLO + method calls : ACTIVE l'outil `call_model_method`
        //   (execute_kw brut : action_post, action_confirm, account.move.send,
        //   wizards, lettrage…). Sans ces flags le backend NE L'ENREGISTRE PAS
        //   (tools.py:748, double opt-in is_write_allowed + enable_method_calls)
        //   — l'addon MCP standard ne l'expose JAMAIS, il EXIGE le mode YOLO.
        //   La sécurité de cet outil (le plus dangereux : il peut tout appeler,
        //   y compris unlink) NE vient PAS du backend (YOLO = access_control
        //   bypassé) mais du hook harnais odoo-provenance.js qui gate
        //   `call_model_method` sur la provenance des ids (arguments[0]).
        //   Défaut = ACTIVÉ (config.yolo, comportement historique) ; opt-out
        //   `ODOO_PROXY_YOLO=false` → le backend retrouve SA couche d'access
        //   control et call_model_method disparaît (déploiement public prudent).
        //   NE JAMAIS désactiver chez nous sans renoncer aux méthodes métier.
        ...(this.config.yolo === false ? {} : { ODOO_YOLO: "true", ODOO_MCP_ENABLE_METHOD_CALLS: "true" }),
      },
    });
    this.process = proc;

    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      const s = String(d);
      stderrBuf += s;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      process.stderr.write(`[odoo] ${s}`);
    });

    proc.on("exit", (code) => {
      if (this.process !== proc) return;
      process.stderr.write(`[odoo] exited code=${code}\n`);
      for (const [, p] of this._pending) {
        try { p.reject(new Error(`Backend exited (code=${code})`)); } catch {}
      }
      this._pending.clear();
    });

    proc.on("error", (err) => {
      process.stderr.write(`[odoo] spawn error: ${err.message}\n`);
    });

    this._rl = readline.createInterface({ input: proc.stdout });
    this._rl.on("line", (line) => {
      try {
        const resp = JSON.parse(line);
        if (resp.id != null && this._pending.has(resp.id)) {
          const p = this._pending.get(resp.id);
          this._pending.delete(resp.id);
          if (resp.error) p.reject(new Error(JSON.stringify(resp.error)));
          else p.resolve(resp.result || {});
        }
      } catch {}
    });

    try {
      await this._sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "odoo-proxy", version: "1.0.0" },
      }, this.config.initTimeoutMs);
      this._sendNotification("notifications/initialized");
    } catch (e) {
      const tail = stderrBuf.split("\n").filter(Boolean).slice(-3).join(" | ");
      throw new Error(`initialize failed: ${e.message}${tail ? ` — backend stderr: ${tail}` : ""}`);
    }
  }

  // Framing JSON-RPC unique (newline-delimited). Source de vérité partagée
  // par notification + requête → un seul endroit qui écrit sur stdin.
  _write(msg) {
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  _sendNotification(method, params) {
    if (!this._isAlive()) return;
    const msg = { jsonrpc: "2.0", method };
    if (params) msg.params = params;
    try { this._write(msg); } catch {}
  }

  _sendRequest(method, params, timeoutMs = this.config.callTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this._isAlive()) { reject(new Error("Backend not running")); return; }
      this._idCounter++;
      const id = this._idCounter;
      const msg = { jsonrpc: "2.0", id, method };
      if (params) msg.params = params;
      this._pending.set(id, { resolve, reject });
      try { this._write(msg); }
      catch (e) { this._pending.delete(id); reject(e); return; }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Timeout on ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  async getTools() {
    await this.ensureRunning();
    if (this._toolsCache) return this._toolsCache;
    const result = await this._sendRequest("tools/list");
    this._toolsCache = result.tools || [];
    return this._toolsCache;
  }

  // ⚠️ Renvoie { content, isError }. NE PAS réduire à result.content : le backend
  // signale les erreurs d'OUTIL (ex. « Invalid field ») comme un résultat RÉUSSI
  // porteur de isError:true (PAS une erreur JSON-RPC → ne throw pas ici). Jeter
  // isError = rendre l'enrichissement champs mort + masquer l'échec à l'appelant.
  async callTool(name, args) {
    await this.ensureRunning();
    const result = await this._sendRequest("tools/call", { name, arguments: args });
    return { content: result.content || [], isError: result.isError === true };
  }

  // Lit une RESOURCE backend (resources/read). ⚠️ La découverte de champs Odoo
  // passe par la resource `odoo://<model>/fields` (MESURÉ : PAS un tool — aucun
  // `execute_method`/`fields_get` dans ce backend). Renvoie le texte concaténé
  // des blocs `contents[].text`. L'appelant (enrichFieldError) est fail-safe.
  async readResource(uri) {
    await this.ensureRunning();
    const result = await this._sendRequest("resources/read", { uri });
    const contents = Array.isArray(result.contents) ? result.contents : [];
    return contents.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
  }

  // readResource avec cache par URI (capability detection : les définitions de
  // champs ne changent qu'à l'installation d'un module → 1 lecture par process).
  // ⚠️ Cache TRANSPORT (comme _toolsCache) : vidé au respawn du backend (_start).
  //   Seuls les SUCCÈS sont cachés — un échec doit pouvoir être retenté.
  async readResourceCached(uri) {
    if (this._resourceCache.has(uri)) return this._resourceCache.get(uri);
    const text = await this.readResource(uri);
    this._resourceCache.set(uri, text);
    return text;
  }

  // Noms d'outils SI le cache est déjà chaud, sinon null. ⚠️ NE déclenche AUCUN
  // spawn (lecture pure du cache) → valider tôt sans payer le coût réseau.
  knownToolNames() {
    return Array.isArray(this._toolsCache) ? this._toolsCache.map((t) => t.name) : null;
  }
}
