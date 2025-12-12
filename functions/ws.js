// Cloudflare Pages Functions WebSocket relay backed by a Durable Object to avoid isolate splits

const FALLBACK_ALLOWED_ORIGINS = [
  "http://localhost:8788",
  "http://127.0.0.1:8788",
];

function isOriginAllowed(origin, requestHost, env) {
  if (!origin) return true; // allow null origins for local file/testing
  const envOrigins = env?.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",") : [];
  const dynamic = [`https://${requestHost}`, `http://${requestHost}`];
  const allowedList = [...envOrigins, ...FALLBACK_ALLOWED_ORIGINS, ...dynamic].filter(Boolean);
  return allowedList.some((allowed) => origin.startsWith(allowed));
}

function closeSocket(ws, code = 1000, reason = "") {
  try {
    ws.close(code, reason);
  } catch (err) {
    // ignore
  }
}

function safeSend(ws, payload) {
  try {
    ws.send(payload);
    return true;
  } catch (err) {
    return false;
  }
}

function dropViewer(ws) {
  ws?.close?.();
}

function parseMessage(event) {
  try {
    const parsed = JSON.parse(event.data);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.type !== "string") return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function validateVideoPayload(message) {
  if (typeof message.data !== "string") return false;
  if (!message.data.startsWith("data:image/jpeg;base64,")) return false;
  const base64 = message.data.slice("data:image/jpeg;base64,".length);
  if (base64.length > 800000) return false; // ~600KB base64
  if (typeof message.ts !== "number") return false;
  return true;
}

function validateAudioPayload(message) {
  if (typeof message.data !== "string") return false;
  if (message.data.length > 400000) return false;
  if (typeof message.ts !== "number") return false;
  return true;
}

// Durable Object that keeps all WebSocket peers on a single isolate
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.broadcaster = null;
    this.viewers = new Set();
  }

  handleBroadcastMessage(message, sender) {
    switch (message.type) {
      case "video":
        if (!validateVideoPayload(message)) return;
        for (const viewer of Array.from(this.viewers)) {
          if (!safeSend(viewer, JSON.stringify(message))) {
            this.viewers.delete(viewer);
            dropViewer(viewer);
          }
        }
        break;
      case "audio":
        if (!validateAudioPayload(message)) return;
        for (const viewer of Array.from(this.viewers)) {
          if (!safeSend(viewer, JSON.stringify(message))) {
            this.viewers.delete(viewer);
            dropViewer(viewer);
          }
        }
        break;
      case "ping": {
        if (typeof message.ts !== "number") return;
        safeSend(sender, JSON.stringify({ type: "pong", ts: message.ts }));
        break;
      }
      case "pong":
        break;
      default:
        break;
    }
  }

  handleViewerMessage(message, sender) {
    switch (message.type) {
      case "ping":
        if (typeof message.ts !== "number") return;
        safeSend(sender, JSON.stringify({ type: "pong", ts: message.ts }));
        break;
      default:
        break;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const role = url.searchParams.get("role");
    const key = url.searchParams.get("key");
    const broadcastKey = this.env?.BROADCAST_KEY || "SECRET";

    if (role === "broadcaster") {
      if (key !== broadcastKey) {
        closeSocket(server, 1008, "Invalid key");
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.broadcaster) {
        closeSocket(this.broadcaster, 4000, "superseded");
      }
      this.broadcaster = server;
      this.broadcaster.addEventListener("message", (event) => {
        const msg = parseMessage(event);
        if (!msg) return;
        this.handleBroadcastMessage(msg, this.broadcaster);
      });
      this.broadcaster.addEventListener("close", () => {
        this.broadcaster = null;
      });
      this.broadcaster.addEventListener("error", () => {
        this.broadcaster = null;
      });
    } else if (role === "viewer") {
      this.viewers.add(server);
      server.addEventListener("message", (event) => {
        const msg = parseMessage(event);
        if (!msg) return;
        this.handleViewerMessage(msg, server);
      });
      const cleanup = () => this.viewers.delete(server);
      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);
    } else {
      closeSocket(server, 1008, "Invalid role");
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.pathname !== "/ws") {
    return new Response("Not found", { status: 404 });
  }

  const origin = request.headers.get("origin") || "";
  if (!isOriginAllowed(origin, url.host, env)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected websocket", { status: 426 });
  }

  const relayId = env.RELAY.idFromName("default");
  const stub = env.RELAY.get(relayId);
  return stub.fetch(request);
}
