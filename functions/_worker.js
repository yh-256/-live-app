import { onRequest as handleWs, Relay } from "./ws";
import { RoomState } from "./room-state";

export { Relay, RoomState };

const JSON_HEADER = { "Content-Type": "application/json" };

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function makeInternalRequest(original, path) {
  return new Request(`https://roomstate${path}`, {
    method: original.method,
    headers: original.headers,
    body: original.body,
  });
}

async function handleCreate(request, env) {
  const payload = await parseBody(request);
  const roomId = payload.roomId || crypto.randomUUID().replace(/-/g, "");
  const watchCode = payload.watchCode || payload.customWatchCode;
  const viewerLimit = payload.viewerLimit;
  const stub = env.ROOM_STATE.get(env.ROOM_STATE.idFromName(roomId));
  const createBody = {
    roomId,
    watchCode,
    viewerLimit,
  };
  const internalReq = new Request("https://roomstate/create", {
    method: "POST",
    headers: JSON_HEADER,
    body: JSON.stringify(createBody),
  });
  const resp = await stub.fetch(internalReq);
  const data = await resp.json().catch(() => ({}));
  const requestUrl = new URL(request.url);
  const origin = `${requestUrl.protocol}//${requestUrl.host}`;
  const watchUrl = `${origin}/public/viewer.html?room=${roomId}`;
  return new Response(JSON.stringify({ ...data, roomId, watchUrl }), {
    headers: JSON_HEADER,
  });
}

async function handleRoomAction(request, env, roomId, suffix) {
  const stub = env.ROOM_STATE.get(env.ROOM_STATE.idFromName(roomId));
  const internalReq = makeInternalRequest(request, suffix);
  return stub.fetch(internalReq);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return handleWs({ request, env, ctx });
    }
    if (url.pathname === "/api/room/create" && request.method === "POST") {
      return handleCreate(request, env);
    }
    if (url.pathname.startsWith("/api/room/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      const roomId = segments[2];
      const action = segments.slice(3).join("/");
      if (!roomId) {
        return new Response("roomId required", { status: 400 });
      }
      switch (action) {
        case "status":
          return handleRoomAction(request, env, roomId, "/status");
        case "publish/offer":
          return handleRoomAction(request, env, roomId, "/publish");
        case "subscribe/offer":
          return handleRoomAction(request, env, roomId, "/subscribe");
        case "end":
          return handleRoomAction(request, env, roomId, "/end");
        case "viewer/leave":
          return handleRoomAction(request, env, roomId, "/viewer/leave");
        default:
          return new Response("Not found", { status: 404 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
