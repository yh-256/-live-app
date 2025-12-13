import { RealtimeClient } from "./realtime.js";

const DEFAULT_LIMIT = 10;
const MAX_VIEWER_LIMIT = 20;
const STORAGE_KEY = "roomMeta";
const JSON_HEADER = { "Content-Type": "application/json" };

function clamp(value, min, max) {
  if (typeof value !== "number") return min;
  return Math.max(min, Math.min(max, value));
}

function makeResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADER,
  });
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function generateWatchCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateRoomId() {
  return crypto.randomUUID().replace(/-/g, "");
}

export class RoomState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
    this.client = null;
  }

  async loadState() {
    if (this.data) return this.data;
    const stored = (await this.state.storage.get(STORAGE_KEY)) || {};
    this.data = {
      roomId: stored.roomId || null,
      state: stored.state || "idle",
      watchCode: stored.watchCode || null,
      publishedTracks: stored.publishedTracks || [],
      viewerLimit: stored.viewerLimit || DEFAULT_LIMIT,
      viewerCount: stored.viewerCount || 0,
      sessionId: stored.sessionId || null,
      viewerMap: stored.viewerMap || {},
      createdAt: stored.createdAt || Date.now(),
      endedAt: stored.endedAt || null,
      egressEstimateBytes: stored.egressEstimateBytes || 0,
    };
    return this.data;
  }

  async persist() {
    await this.state.storage.put(STORAGE_KEY, {
      ...this.data,
      viewerMap: this.data.viewerMap,
    });
  }

  getRealtimeClient() {
    if (!this.client) {
      this.client = new RealtimeClient(this.env);
    }
    return this.client;
  }

  async handleCreate(request) {
    const body = await parseJson(request);
    await this.loadState();
    this.data.roomId = body.roomId || this.data.roomId || generateRoomId();
    this.data.watchCode = body.watchCode || this.data.watchCode || generateWatchCode();
    this.data.viewerLimit = clamp(body.viewerLimit ?? DEFAULT_LIMIT, 1, MAX_VIEWER_LIMIT);
    this.data.viewerCount = 0;
    this.data.state = "idle";
    this.data.publishedTracks = [];
    this.data.sessionId = null;
    this.data.viewerMap = {};
    this.data.createdAt = Date.now();
    this.data.endedAt = null;
    this.data.egressEstimateBytes = 0;
    await this.persist();
    return makeResponse({
      roomId: this.data.roomId,
      watchCode: this.data.watchCode,
      state: this.data.state,
      viewerCount: this.data.viewerCount,
      limits: {
        viewerLimit: this.data.viewerLimit,
        full: this.data.viewerCount >= this.data.viewerLimit,
      },
    });
  }

  async handleStatus() {
    const data = await this.loadState();
    return makeResponse({
      roomId: data.roomId,
      state: data.state,
      viewerCount: data.viewerCount,
      limits: {
        viewerLimit: data.viewerLimit,
        full: data.viewerCount >= data.viewerLimit,
      },
      watchCodeRequired: Boolean(data.watchCode),
      watchCodeHint: data.watchCode ? data.watchCode.slice(0, 3) + "***" : null,
      publishedTrackNames: data.publishedTracks.map((t) => t.trackName),
    });
  }

  async ensureLive() {
    const data = await this.loadState();
    if (data.state !== "live") {
      throw new Error("room_not_live");
    }
    if (!data.sessionId) {
      throw new Error("missing_session");
    }
    return data;
  }

  async handlePublish(request) {
    const body = await parseJson(request);
    if (!body.offer) {
      return makeResponse({ error: "offer_required" }, 400);
    }
    const data = await this.loadState();
    if (!data.roomId) {
      return makeResponse({ error: "room_not_initialized" }, 400);
    }
    const tracks = (body.tracks || []).map((entry, index) => ({
      trackName: entry.trackName || `track-${index}`,
      kind: entry.kind || "video",
      mid: entry.mid,
      bitrate: entry.bitrate,
      captureSettings: entry.captureSettings,
    }));
    const realtime = this.getRealtimeClient();
    const sessionRes = await realtime.newSession(body.offer);
    const sessionId = sessionRes.sessionId || sessionRes.data?.sessionId || sessionRes.session?.id;
    if (!sessionId) {
      return makeResponse({ error: "session_id_missing" }, 500);
    }
    data.sessionId = sessionId;
    const tracksRes = await realtime.newTracks(sessionId, tracks, body.offer);
    const trackMetadata = tracksRes.tracks || [];
    data.publishedTracks = tracks.map((entry, index) => ({
      ...entry,
      mid: entry.mid || trackMetadata[index]?.mid,
    }));
    data.state = "live";
    data.endedAt = null;
    await this.persist();
    return makeResponse({
      publisherAnswer: tracksRes.sessionDescription,
      publishedTrackIds: tracksRes.tracks || [],
      state: data.state,
    });
  }

  async handleSubscribe(request) {
    const body = await parseJson(request);
    if (!body.offer) {
      return makeResponse({ error: "offer_required" }, 400);
    }
    const data = await this.loadState();
    if (data.state !== "live") {
      return makeResponse({ error: "room_not_live" }, 409);
    }
    if (body.watchCode !== data.watchCode) {
      return makeResponse({ error: "invalid_watch_code" }, 403);
    }
    if (data.viewerCount >= data.viewerLimit) {
      return makeResponse({ error: "room_full", limits: { viewerLimit: data.viewerLimit, full: true } }, 409);
    }
    if (!data.sessionId) {
      return makeResponse({ error: "session_missing" }, 500);
    }
    const viewerId = body.viewerId || crypto.randomUUID();
    const trackRequests = data.publishedTracks.map((track) => ({
      location: "remote",
      sessionId: data.sessionId,
      trackName: track.trackName,
      mid: track.mid,
    }));
    const realtime = this.getRealtimeClient();
    const tracksRes = await realtime.newTracks(data.sessionId, trackRequests, body.offer);
    data.viewerMap[viewerId] = Date.now();
    data.viewerCount += 1;
    data.egressEstimateBytes += (body.egressEstimate || 0);
    await this.persist();
    return makeResponse({
      viewerAnswer: tracksRes.sessionDescription,
      viewerId,
      state: data.state,
    });
  }

  async handleViewerLeave(request) {
    const body = await parseJson(request);
    const data = await this.loadState();
    if (body.viewerId && data.viewerMap[body.viewerId]) {
      delete data.viewerMap[body.viewerId];
      data.viewerCount = Math.max(0, data.viewerCount - 1);
      await this.persist();
    }
    return makeResponse({ viewerCount: data.viewerCount });
  }

  async handleEnd(request) {
    const data = await this.loadState();
    data.state = "ended";
    data.endedAt = Date.now();
    data.viewerMap = {};
    data.viewerCount = 0;
    await this.persist();
    return makeResponse({ state: data.state });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    try {
      if (pathname === "/create" && request.method === "POST") {
        return this.handleCreate(request);
      }
      if (pathname === "/status" && request.method === "GET") {
        return this.handleStatus();
      }
      if (pathname === "/publish" && request.method === "POST") {
        return this.handlePublish(request);
      }
      if (pathname === "/subscribe" && request.method === "POST") {
        return this.handleSubscribe(request);
      }
      if (pathname === "/viewer/leave" && request.method === "POST") {
        return this.handleViewerLeave(request);
      }
      if (pathname === "/end" && request.method === "POST") {
        return this.handleEnd(request);
      }
    } catch (error) {
      console.error("RoomState error", error);
      return makeResponse({ error: error.message || "internal_error" }, 500);
    }
    return new Response("Not found", { status: 404 });
  }
}
