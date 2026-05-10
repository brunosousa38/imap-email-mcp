# IMAP Email MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude access to any IMAP/SMTP mailbox. Read, search, compose, send, and manage emails using natural language.

This server runs as a **secured HTTPS service** — it is designed to be self-hosted in Docker and exposed on the internet so that Claude (or any MCP-compatible client) can reach it remotely.

---

## Architecture

```
Claude (MCP client)
        │  HTTPS + Bearer token
        ▼
Reverse proxy (Caddy or Traefik)
        │  HTTP  :3000  (internal)
        ▼
Express HTTP server
  ├─ Helmet (security headers)
  ├─ Rate limiter (60 req/min)
  └─ Bearer token auth (MCP_API_KEY)
        │
  MCP StreamableHTTP transport
        │
  IMAP / SMTP (your email provider)
```

---

## Prerequisites

- Docker and Docker Compose installed on the host
- A domain name pointing to the host (A/AAAA record)
- An **app password** from your email provider (never use your main password)

---

## Deployment

### 1. Clone and configure

```bash
git clone https://github.com/brunosousa38/imap-email-mcp.git
cd imap-email-mcp
cp .env.example .env
```

Edit `.env` and fill in every value (see [Configuration](#configuration) below).

```bash
# Generate a strong API key
openssl rand -hex 32
```

Paste the output as `MCP_API_KEY` in your `.env`.

---

### Option A — Caddy (recommended, includes automatic TLS)

Use this if you have no existing reverse proxy on the host. Caddy handles TLS certificates from Let's Encrypt automatically.

**`.env` variables required:**
```env
DOMAIN=mcp.example.com
```

**Start:**
```bash
docker compose up -d
```

Caddy will obtain a TLS certificate on first start. The server will be available at `https://mcp.example.com/mcp`.

---

### Option B — Traefik (if a Traefik instance already runs on the host)

Use this when Traefik is already managing routing on the host. The app container joins the existing Traefik network via labels.

**`.env` variables required:**
```env
DOMAIN=mcp.example.com
TRAEFIK_NETWORK=traefik_proxy   # name of the existing Traefik Docker network
CERT_RESOLVER=letsencrypt       # name of the Let's Encrypt resolver in your Traefik config
```

**Start:**
```bash
docker compose -f docker-compose.traefik.yml up -d
```

HTTP → HTTPS redirect is configured automatically via Traefik labels.

---

### Option C — Cloudflare Worker (proxy, no domain needed)

Use this if you want to expose the server via Cloudflare's edge network without managing a domain or TLS yourself. The Worker acts as a secure proxy in front of the Docker container.

**How it works:**
```
Claude → https://your-worker.workers.dev/mcp/TOKEN/ → Docker backend
```

The token is part of the URL — no custom header needed in Claude's configuration.

**Prerequisites:** the Docker container must be running and publicly reachable (Option A or B above, or any public URL).

**Setup:**

1. Open `worker.js` and fill in the three variables at the top:

```javascript
const API_TOKEN   = 'your-secret-token';            // token in the URL
const BACKEND_URL = 'https://your-docker.example.com'; // Docker public URL
const BACKEND_KEY = 'your-docker-MCP_API_KEY';      // MCP_API_KEY from .env
```

2. Deploy:

```bash
npm install -g wrangler
wrangler login
wrangler deploy worker.js --name imap-mcp
```

Or paste `worker.js` directly into the [Cloudflare Workers dashboard](https://workers.cloudflare.com) — no CLI needed.

3. Connect Claude using the Worker URL:

```
https://imap-mcp.your-account.workers.dev/mcp/YOUR_TOKEN/
```

**Verify:**
```bash
curl https://imap-mcp.your-account.workers.dev/health
# Expected: {"status":"ok","worker":true}
```

---

### Verify the deployment

```bash
# Health check (no authentication required)
curl https://mcp.example.com/health
# Expected: {"status":"ok","version":"1.0.0"}
```

---

## Configuration

Copy `.env.example` to `.env` and fill in all values.

### Authentication

| Variable | Required | Description |
|---|---|---|
| `MCP_API_KEY` | **Yes** | Bearer token Claude uses to authenticate. Generate with `openssl rand -hex 32`. |

### HTTP server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Internal HTTP port (not exposed directly — only via the reverse proxy). |

### Reverse proxy

| Variable | Required for | Description |
|---|---|---|
| `DOMAIN` | Both | Public hostname (e.g. `mcp.example.com`). |
| `TRAEFIK_NETWORK` | Traefik only | Name of the existing external Docker network used by Traefik. |
| `CERT_RESOLVER` | Traefik only | Name of the Let's Encrypt resolver configured in Traefik. |

### IMAP (reading emails)

| Variable | Required | Default | Description |
|---|---|---|---|
| `IMAP_USER` | **Yes** | — | Your email address. |
| `IMAP_PASSWORD` | **Yes** | — | App password (not your main password). |
| `IMAP_HOST` | **Yes** | — | IMAP server hostname. |
| `IMAP_PORT` | No | `993` | IMAP port. |
| `IMAP_TLS` | No | `true` | Enable TLS. Set to `false` only for local testing. |

### SMTP (sending emails)

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | No | same as `IMAP_HOST` | SMTP server hostname. |
| `SMTP_PORT` | No | `465` | SMTP port. |
| `SMTP_SECURE` | No | `true` | Use implicit TLS (port 465). Set to `false` for STARTTLS (port 587). |
| `SMTP_USER` | No | same as `IMAP_USER` | SMTP username if different from IMAP. |
| `SMTP_PASSWORD` | No | same as `IMAP_PASSWORD` | SMTP password if different from IMAP. |

### Provider quick reference

| Provider | `IMAP_HOST` | `SMTP_HOST` | Notes |
|---|---|---|---|
| **Gmail** | `imap.gmail.com` | `smtp.gmail.com` | [Create App Password](https://myaccount.google.com/apppasswords) — 2FA must be enabled |
| **Outlook / Microsoft 365** | `outlook.office365.com` | `smtp.office365.com` | `SMTP_PORT=587`, `SMTP_SECURE=false` |
| **Yahoo** | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com` | Generate App Password in Account Security settings |
| **Fastmail** | `imap.fastmail.com` | `smtp.fastmail.com` | App Password from Privacy & Security |
| **iCloud** | `imap.mail.me.com` | `smtp.mail.me.com` | [Generate App Password](https://appleid.apple.com/) |

---

## Connecting Claude

Once the server is running, add it as an MCP server in Claude.

The URL format depends on how you deployed:

| Deployment | MCP URL |
|---|---|
| Caddy / Traefik (Docker) | `https://mcp.example.com/mcp` + Bearer header |
| Cloudflare Worker | `https://imap-mcp.account.workers.dev/mcp/YOUR_TOKEN/` |

### Claude Code (CLI)

**With Docker (Caddy or Traefik) — Bearer header:**
```bash
claude mcp add imap-email \
  --transport http \
  --url https://mcp.example.com/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

**With Cloudflare Worker — token in URL, no header needed:**
```bash
claude mcp add imap-email \
  --transport http \
  --url https://imap-mcp.your-account.workers.dev/mcp/YOUR_TOKEN/
```

Verify:
```bash
claude mcp list
claude mcp get imap-email
```

Remove:
```bash
claude mcp remove imap-email
```

### Claude Desktop

Edit the config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**With Docker (Caddy or Traefik):**
```json
{
  "mcpServers": {
    "imap-email": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

**With Cloudflare Worker:**
```json
{
  "mcpServers": {
    "imap-email": {
      "type": "http",
      "url": "https://imap-mcp.your-account.workers.dev/mcp/YOUR_TOKEN/"
    }
  }
}
```

Restart Claude Desktop after saving.

---

## Available Tools

| Tool | Description |
|---|---|
| `list_folders` | List all folders/mailboxes in the account |
| `list_emails` | List emails from a folder, with optional filters (unread only, since date, limit) |
| `get_email` | Get full content of an email by UID (text, HTML, attachments list) |
| `search_emails` | Search by subject, sender, or body text |
| `list_drafts` | List all draft emails |
| `get_draft` | Get a specific draft by UID |
| `create_draft` | Create a new draft email |
| `update_draft` | Replace an existing draft |
| `send_email` | Send an email via SMTP |
| `delete_email` | Permanently delete an email by UID |

---

## Usage Examples

Once connected, use natural language with Claude:

- *"Check my inbox for unread emails"*
- *"Search for emails from alice@example.com about the budget"*
- *"Create a draft to bob@example.com — subject: Meeting recap, summarise our last discussion"*
- *"Send an email to the team at team@example.com with the agenda for Friday"*
- *"Delete email UID 4521 from my Spam folder"*
- *"List my drafts and show me the most recent one"*

---

## Security

The server implements several layers of protection:

| Layer | Mechanism |
|---|---|
| **Transport** | HTTPS enforced by Caddy or Traefik (TLS 1.2+, Let's Encrypt) |
| **Authentication** | Bearer token (`MCP_API_KEY`) checked on every MCP request via timing-safe comparison |
| **Rate limiting** | 60 requests per minute per IP |
| **Security headers** | `helmet()` middleware (HSTS, X-Frame-Options, X-Content-Type-Options, …) |
| **Input validation** | UID must be a positive integer; folder names block IMAP control characters; `to`/`cc`/`bcc` validated as email addresses; text fields capped at 10 000 chars |
| **Header injection** | RFC 2822 headers sanitized (CR/LF stripped) before raw message construction |
| **Container** | Non-root user (`node`, uid 1000); multi-stage Alpine image; app port not exposed to the host |
| **Network isolation** | App container reachable only via the reverse proxy (no direct port mapping) |

**Recommended practices:**
- Use an **app password** from your provider — never your main account password.
- Rotate `MCP_API_KEY` periodically (`openssl rand -hex 32`).
- Prefer `create_draft` over `send_email` when you want to review before sending.

---

## Troubleshooting

**`curl /health` returns connection refused**
- Check that the container is running: `docker compose ps`
- Check logs: `docker compose logs mcp-email`

**401 Unauthorized**
- Verify the `Authorization: Bearer <key>` header matches `MCP_API_KEY` in `.env` exactly.

**403 Forbidden**
- `MCP_API_KEY` is not set in `.env`. The server refuses all requests when no key is configured.

**IMAP authentication failed**
- Confirm IMAP access is enabled in your provider's settings (Gmail: *Less secure app access* or App Passwords; Outlook: Modern Auth settings).
- Verify the app password — copy-paste it, do not retype.

**Drafts folder not found**
- The server tries `Drafts`, `INBOX.Drafts`, `[Gmail]/Drafts`, `Draft`. If your provider uses another name, check with `list_folders` and open an issue.

**TLS certificate not issued (Caddy)**
- Ensure port 80 is reachable from the internet (Let's Encrypt HTTP-01 challenge).
- Check Caddy logs: `docker compose logs caddy`

**Traefik not routing to the container**
- Confirm the container joined the correct network: `docker network inspect $TRAEFIK_NETWORK`
- Verify `CERT_RESOLVER` matches the name in your Traefik static config.

---

## License

MIT — see [LICENSE](LICENSE) for details.
