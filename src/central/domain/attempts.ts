// One delivery attempt of a central command.

export type DeliveryResult = "delivered" | "unknown";
export type CentralAttempt = { id: string; commandId: string; hostId: string; status: "started" | DeliveryResult; detail: string | null };
