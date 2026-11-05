import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntime } from "../../src/runtime.js";

function send(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization;
  if (!secret || authorization !== `Bearer ${secret}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }

  const runtime = getRuntime();
  const snapshot = await runtime.snapshots.refresh(true);
  send(res, 200, {
    ok: Boolean(snapshot),
    ...runtime.snapshots.getHealth(),
  });
}
