import { onRequest as handleWs, Relay } from "./ws";

// Export Durable Object class so Wrangler can bind it
export { Relay };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      // Delegate to the same handler used in file-based function
      return handleWs({ request, env, ctx });
    }
    // For all other paths, serve static assets (Pages)
    return env.ASSETS.fetch(request);
  },
};
