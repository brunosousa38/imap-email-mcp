// =============================================================================
// IMAP Email MCP Server — Cloudflare Worker (mode proxy)
//
// Ce Worker expose le serveur MCP sur internet avec le token intégré dans
// l'URL. Ajoutez ce MCP dans Claude avec l'URL :
//   https://votre-worker.workers.dev/mcp/VOTRE_TOKEN/
//
// Prérequis : le container Docker imap-email-mcp doit tourner et être
// accessible (via Caddy ou Traefik). Voir docker-compose.yml.
//
// Déploiement rapide :
//   1. Installer Wrangler : npm install -g wrangler
//   2. Se connecter      : wrangler login
//   3. Déployer          : wrangler deploy worker.js --name imap-mcp
//
// Ou coller le contenu directement dans le dashboard Cloudflare Workers.
// =============================================================================

// ── Variables à configurer ────────────────────────────────────────────────────

// Token secret inclus dans l'URL Claude : /mcp/VOTRE_TOKEN/
// Générer avec : openssl rand -hex 32
const API_TOKEN = 'CHANGE_ME_TOKEN';

// URL publique du container Docker (sans slash final)
// Exemple : https://mcp.example.com  ou  https://mon-vps.example.com:3000
const BACKEND_URL = 'https://CHANGE_ME_DOCKER_URL';

// MCP_API_KEY configuré sur le container Docker (variable MCP_API_KEY dans .env)
// Le Worker l'ajoute en header Authorization: Bearer pour authentifier le Docker
const BACKEND_KEY = 'CHANGE_ME_BACKEND_KEY';

// ── Fin de configuration ──────────────────────────────────────────────────────

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check public — pas de token requis
    if (path === '/health' || path === '/health/') {
      return jsonResponse({ status: 'ok', worker: true }, 200);
    }

    // Format attendu : /mcp/{TOKEN}[/chemin-optionnel][?params]
    const match = path.match(/^\/mcp\/([^/]+)(\/.*)?$/);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    // Validation du token à temps constant pour éviter les timing attacks
    const token = match[1];
    if (!timingSafeEqual(token, API_TOKEN)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Construire le chemin backend : /mcp/{TOKEN}[/...] → /mcp[/...]
    const trailingPath = match[2] ?? '';
    const backendPath = '/mcp' + trailingPath;
    const backendUrl = BACKEND_URL + backendPath + url.search;

    const backendRequest = new Request(backendUrl, {
      method: request.method,
      headers: buildBackendHeaders(request.headers),
      // GET et HEAD n'ont pas de body
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });

    try {
      // Passe la réponse telle quelle (supporte le streaming SSE pour MCP)
      return await fetch(backendRequest);
    } catch {
      return new Response('Backend unavailable', { status: 502 });
    }
  },
};

// Prépare les headers envoyés au Docker :
// - remplace l'Authorization par la clé backend
// - supprime les headers Cloudflare internes non pertinents
function buildBackendHeaders(incoming) {
  const headers = new Headers(incoming);
  headers.set('Authorization', `Bearer ${BACKEND_KEY}`);
  // Ces headers sont propres à Cloudflare et n'ont pas de sens côté backend
  for (const h of ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor']) {
    headers.delete(h);
  }
  return headers;
}

// Comparaison à temps constant — évite qu'un attaquant déduise le token
// caractère par caractère via les différences de temps de réponse.
// Note : les longueurs différentes court-circuitent (la longueur du token
// est visible dans l'URL de toute façon, ce n'est pas une fuite utile).
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
