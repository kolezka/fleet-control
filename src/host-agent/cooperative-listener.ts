export interface CooperativeListenerOptions {
  handler: (request: Request) => Response | Promise<Response>;
  port?: number;
}

// The adapter owns bearer authentication. The listener must not replace it.
export function createCooperativeListener({ handler, port = 0 }: CooperativeListenerOptions) {
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const host = request.headers.get("host");
      if ((host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) || request.headers.has("origin")) {
        return new Response("Forbidden", { status: 403 });
      }
      if (stopping) return new Response("Stopping", { status: 503 });
      return Promise.resolve().then(() => handler(request)).catch(() => new Response("Internal Server Error", { status: 500 }));
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) throw new Error("listener has no TCP port");
  return {
    port: boundPort,
    stop(): Promise<void> {
      if (!stopped) {
        stopping = true;
        // Closing connections does not cancel handler work, which may continue in the background.
        stopped = server.stop(true);
      }
      return stopped;
    },
  };
}
