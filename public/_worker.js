import { onRequest as handleWs, Relay } from "../functions/ws";

// Export Durable Object class so wrangler can bind it
export { Relay };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return handleWs({ request, env, ctx });
    }
    // serve static assets
    return env.ASSETS.fetch(request);
  },
};
