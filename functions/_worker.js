import { onRequest as handleWs, Relay } from "./ws";

export { Relay };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return handleWs({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  },
};
