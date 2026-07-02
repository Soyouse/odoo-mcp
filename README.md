# odoo-mcp — Guarded Odoo MCP for Claude Code

*[Version française : [README.fr.md](README.fr.md)]*

An MCP server that lets Claude (or any MCP client) operate an [Odoo](https://www.odoo.com) CRM/ERP — **with guardrails designed for real money and real customers**.

Plain Odoo over XML-RPC is *blind*: business methods often return `null` while silently creating invoices and emailing your customers. An AI agent driving that API will eventually double-send an invoice email — ours did. This proxy exists so that class of incident can't happen again, for anyone.

## What it adds on top of a raw Odoo MCP

- **Post-write readback ("sighted MCP")** — after every successful write, the proxy re-reads the touched records and appends their *real* database state (`state`, `payment_state`, `is_move_sent`, …) to the result. Never trust a method's return value; always re-read.
- **Duplicate-send guard (fail-closed)** — re-sending an invoice that is already `is_move_sent=true` is **blocked** before it reaches Odoo. If the state can't be verified, it's blocked too. Explicit override: `force_resend: true`.
- **Duplicate-invoice guard (fail-closed)** — re-running subscription invoicing when a non-cancelled invoice already exists for the current month is **blocked** (a second receivable is worse than a second email). Override: `force_create: true`.
- **Silent-email scan** — every write is bracketed by a `mail.message` snapshot/diff: any email that left towards a recipient *during* the call is reported (`📧`), or you get a positive "no recipient notified".
- **Known-pitfall warnings** — when the agent calls a method with a known trap (e.g. `generate_invoice` may create *and email* the invoice in one transaction), the warning is appended to the result — no skill or doc needs to be loaded.
- **Capability detection** — fields to re-read are intersected with the server's *actual* fields (introspected via the `odoo://<model>/fields` resource), so the proxy works across Odoo 17/18 and missing modules degrade cleanly instead of erroring.
- **ID-provenance hook (anti-hallucination)** — Odoo IDs are short sequential integers; a hallucinated ID usually hits a *real* record. The bundled Claude Code hook blocks any mutation (`update_record`, `delete_record`, `post_message`, `call_model_method`) targeting an ID that was never returned by a read *in this session*. Read-before-Edit, ported to Odoo.
- **Optional NTFY canary** — every guard trigger can ping an [ntfy](https://ntfy.sh) topic, so a human sees blocked actions without being in the loop.
- **Never-crash proxy** — lazy spawn, retries, hot-reload of business logic; handler errors come back as tool results, never as transport failures.

## Architecture

```
Claude ⇄ (2 meta-tools: odoo_discover / odoo_call) ⇄ proxy.js ⇄ pip package mcp-server-odoo ⇄ Odoo XML-RPC
```

The proxy wraps the excellent [`mcp-server-odoo`](https://pypi.org/project/mcp-server-odoo/) (pinned `==0.6.0`) and exposes just two meta-tools, keeping the tool surface small for the model.

## Install (Claude Code plugin)

```
/plugin marketplace add Soyouse/odoo-mcp
/plugin install odoo-mcp@soyouse
```

Prerequisites: Node ≥ 20 and Python ≥ 3.10 with the backend installed:

```
pip install mcp-server-odoo==0.6.0
```

Then set your credentials as environment variables (see below) and restart Claude Code.

## Configuration (environment variables)

| Variable | Required | Description |
|---|---|---|
| `ODOO_URL` | yes | Odoo base URL |
| `ODOO_DB` | yes | Database name |
| `ODOO_USER` (alias `ODOO_LOGIN`) | yes* | Login |
| `ODOO_PASSWORD` | yes* | Password |
| `ODOO_API_KEY` | yes* | API key (alternative to login+password) |
| `ODOO_PROXY_YOLO` | no (default `false` as plugin) | `true` enables `call_model_method` (raw `execute_kw`). See security note. |
| `ODOO_PYTHON` | no | Python executable (default `python`) |
| `ODOO_CANARY_ENV` | no | Path to a `KEY=value` file with `NTFY_URL`/`NTFY_TOPIC` (+ optional `NTFY_USER`/`NTFY_PASS`) to enable guard-trigger pings |

*Either `ODOO_API_KEY`, or `ODOO_USER`+`ODOO_PASSWORD`.

## Security model — read this before enabling YOLO

With `ODOO_PROXY_YOLO=true`, the Python backend bypasses **its own access-control layer** and registers `call_model_method`, which can call *any* model method (including `unlink`). This is the only way to execute business methods (post an invoice, confirm an order, run wizards). In that mode your protections are, by design:

1. the Odoo user's own access rights (use a dedicated, least-privilege user),
2. this proxy's guards (duplicate-send, duplicate-invoice, readback),
3. the provenance hook (no mutation on an ID never read this session).

Default is **off**: without YOLO the backend enforces its normal ACL and `call_model_method` doesn't exist.

Note: tool messages are currently in French (built for a French agency's production CRM); LLMs handle them fine regardless of your working language.

## Development

```
npm test           # 8 suites, zero network, fake stdio backend
npm run mutation   # Stryker on the pure logic (break threshold 85, ratchet)
```

MIT © Soyouse
