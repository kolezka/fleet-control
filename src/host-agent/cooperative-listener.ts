export interface CooperativeListenerOptions {
  handler: (request: Request) => Response | Promise<Response>;
  port?: number;
  shutdownTimeoutMs?: number;
}

// The adapter owns bearer authentication. The listener must not replace it.
export function createCooperativeListener({ handler, port = 0, shutdownTimeoutMs = 5_000 }: CooperativeListenerOptions) {
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 2_147_483_647) throw new Error("invalid shutdown timeout");
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const handlers = new Set<Promise<Response>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const host = request.headers.get("host");
      if ((host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) || request.headers.has("origin")) {
        return new Response("Forbidden", { status: 403 });
      }
      if (stopping) return new Response("Stopping", { status: 503 });
      const work = Promise.resolve().then(() => handler(request)).catch(() => new Response("Internal Server Error", { status: 500 }));
      handlers.add(work);
      void work.then(() => { handlers.delete(work); });
      return work;
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) throw new Error("listener has no TCP port");
  return {
    port: boundPort,
    stop(): Promise<void> {
      if (!stopped) {
        stopping = true;
        stopped = (async () => {
          const graceful = Promise.all([server.stop(false), ...handlers]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const drained = await Promise.race([graceful.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); })]);
            // Force closing does not undo upstream effects or cancel uncooperative handlers.
            if (!drained) await server.stop(true);
          } finally { if (timer) clearTimeout(timer); }
        })();
      }
      return stopped;
    },
  };
}
