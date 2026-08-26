/**
 * Boots the real API (same router the Vercel function uses) on an ephemeral
 * port so integration tests can drive it over HTTP with fetch().
 */
import type { Server } from "node:http";
import { startServer } from "../../scripts/dev-server.js";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(port = 0): Promise<TestServer> {
  const { server, url } = await startServer(port);
  const closed = new Promise<void>((resolve) => server.on("close", resolve));
  return {
    url,
    close: async () => {
      server.close();
      await closed;
    }
  };
}

export type { Server };
