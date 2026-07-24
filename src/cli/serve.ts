import { startServer } from "../server/node-server";

export async function serveCommand(): Promise<void> {
  await startServer();
  // Keep the process alive; the HTTP server holds it open.
}
