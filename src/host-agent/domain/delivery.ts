// Delivery attempt and receipt records kept on the host.

export type AttemptStatus = "started" | "delivered" | "unknown";
export type DeliveryAttempt = { id: string; fingerprint: string; status: AttemptStatus };

export type HostReceipt = Readonly<{
  hostId: string;
  commandId: string;
  attemptId: string;
  status: "delivered" | "unknown";
}>;
