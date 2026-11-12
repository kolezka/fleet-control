import type { Server, ServerWebSocket } from "bun";
import { AgentSockets, MAX_AGENT_MESSAGE_BYTES, type AgentInventory } from "./agent-sockets.ts";
import type { CentralAuth } from "./auth.ts";

export type HostSocketData = { hostId: string };

// Mount fetch at /api/host/socket before the HTTP app, and pass websocket to Bun.serve.
// The caller must bind the server to loopback. This adapter never dispatches commands.
export function createHostSocketServer(options: {
  auth: CentralAuth;
  onInventory: (inventory: AgentInventory) => void | Promise<void>;
}) {
  const sockets = new AgentSockets({
    validateAttempt: () => false,
    onReceipt: () => { throw new Error("receipts are disabled"); },
    onInventory: options.onInventory,
  });

  const generations = new WeakMap<ServerWebSocket<HostSocketData>, object>();

  return {
    listHosts: () => sockets.listHosts(),
    fetch(request: Request, server: Pick<Server<HostSocketData>, "upgrade">): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname !== "/api/host/socket") return new Response("not found", { status: 404 });
      if (request.method !== "GET" || url.search) return new Response("bad request", { status: 400 });
      // Host agents have no browser origin. Reject even an empty Origin header.
      if (request.headers.has("origin")) return new Response("unsafe origin", { status: 403 });
      const principal = options.auth.authenticate(request);
      if (!principal) return new Response("unauthorized", { status: 401 });
      if (principal.role !== "host") return new Response("forbidden", { status: 403 });
      if (!server.upgrade(request, { data: { hostId: principal.hostId } })) {
        return new Response("upgrade required", { status: 426 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: MAX_AGENT_MESSAGE_BYTES,
      open(socket: ServerWebSocket<HostSocketData>) {
        if (sockets.connect(socket.data.hostId, socket)) generations.set(socket, {});
      },
      message(socket: ServerWebSocket<HostSocketData>, message: string | Buffer) {
        const generation = generations.get(socket);
        const hostId = socket.data.hostId;
        void sockets.message(hostId, socket, message).catch(() => {
          if (!generation || generations.get(socket) !== generation) return;
          generations.delete(socket);
          sockets.disconnect(hostId, socket);
          socket.close(1011, "inventory failed");
        });
      },
      close(socket: ServerWebSocket<HostSocketData>) {
        generations.delete(socket);
        sockets.disconnect(socket.data.hostId, socket);
      },
    },
  };
}
