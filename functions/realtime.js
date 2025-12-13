const DEFAULT_REALTIME_BASE = "https://rtc.live.cloudflare.com/v1";
const JSON_HEADER = { "Content-Type": "application/json" };

export class RealtimeClient {
  constructor(env) {
    this.appId = env?.REALTIME_APP_ID || "";
    this.token = env?.REALTIME_API_TOKEN || "";
    this.baseUrl = env?.REALTIME_BASE_URL || DEFAULT_REALTIME_BASE;
    if (!this.appId) {
      throw new Error("REALTIME_APP_ID is required");
    }
    if (!this.token) {
      throw new Error("REALTIME_API_TOKEN is required");
    }
  }

  buildUrl(path) {
    const trimmedPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}/apps/${this.appId}${trimmedPath}`;
  }

  async sendRequest(path, body, method = "POST") {
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      method,
      headers: {
        ...JSON_HEADER,
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.errors?.[0]?.message || `Realtime request failed: ${response.status}`);
    }
    if (json.errorCode) {
      throw new Error(json.errorDescription || "Realtime API error");
    }
    if (json.success && json.result) {
      return json.result;
    }
    return json;
  }

  async newSession(offerSdp) {
    return this.sendRequest("/sessions/new", {
      sessionDescription: { type: "offer", sdp: offerSdp },
    });
  }

  async newTracks(sessionId, tracks, offerSdp = null) {
    const path = `/sessions/${sessionId}/tracks/new`;
    const body = {
      tracks,
    };
    if (offerSdp) {
      body.sessionDescription = { type: "offer", sdp: offerSdp };
    }
    return this.sendRequest(path, body);
  }

  async renegotiate(sessionId, answerSdp) {
    return this.sendRequest(`/sessions/${sessionId}/renegotiate`, {
      sessionDescription: { type: "answer", sdp: answerSdp },
    }, "PUT");
  }

  async closeTrack(sessionId, trackName) {
    return this.sendRequest(`/sessions/${sessionId}/tracks/close`, {
      tracks: [{ trackName }],
    }, "PUT");
  }

  async getSession(sessionId) {
    const path = `/sessions/${sessionId}`;
    const url = this.buildUrl(path);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!response.ok) {
      throw new Error("Failed to fetch Realtime session");
    }
    return response.json();
  }
}
