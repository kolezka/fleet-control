// Typing into a pane. The host types only for the socket holding the session's input lease; this
// module is the page's view of that lease. Every change of state comes from the host: a click only
// asks, and keys are sent only after the host said "granted" on this socket.

export type LeaseState = "off" | "confirm" | "asking" | "held" | "releasing";
export type LeaseView = { socket: string | null; state: LeaseState; expiresAt: string | null; note: string };

export const noLease: LeaseView = { socket: null, state: "off", expiresAt: null, note: "" };
export const LEASE_MINUTES = 5;
// A pending confirmation lapses, so a stray second click much later cannot grant a lease.
export const CONFIRM_MS = 8000;

const text = (v: unknown, max = 300): string | null => (typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

// Applies one text frame from the host. Unknown or malformed frames change nothing.
export function onControlFrame(view: LeaseView, raw: string): LeaseView {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return view; }
  if (!m || typeof m !== "object") return view;
  const f = m as Record<string, unknown>;
  if (f.type === "socket") {
    const id = text(f.id, 100);
    return id ? { ...noLease, socket: id } : view;
  }
  if (f.type === "lease" && f.state === "granted") {
    const until = text(f.expiresAt, 40);
    return until && view.socket ? { ...view, state: "held", expiresAt: until, note: "" } : view;
  }
  if (f.type === "lease" && f.state === "ended") {
    return { ...view, state: "off", expiresAt: null, note: endNote(text(f.reason) ?? "ended") };
  }
  if (f.type === "input_error") return { ...view, note: text(f.message) ?? "the host refused that input" };
  return view;
}

function endNote(reason: string): string {
  if (reason === "released") return "Typing stopped";
  if (reason === "lease expired") return "Typing lease expired";
  if (reason === "terminal closed") return "Typing ended with the connection";
  return `Typing ended: ${reason}`;
}

// What the pane's typing button shows. Hidden when the host offers no input on this socket.
export function leaseButton(view: LeaseView, session: string): { hidden: boolean; label: string; disabled: boolean; danger: boolean } {
  if (!view.socket) return { hidden: true, label: "", disabled: true, danger: false };
  switch (view.state) {
    case "off": return { hidden: false, label: "Type…", disabled: false, danger: false };
    case "confirm": return { hidden: false, label: `Confirm: type into ${session} for ${LEASE_MINUTES} min`, disabled: false, danger: true };
    case "asking": return { hidden: false, label: "Asking the host…", disabled: true, danger: false };
    case "held": return { hidden: false, label: "Stop typing", disabled: false, danger: false };
    case "releasing": return { hidden: false, label: "Stopping…", disabled: true, danger: false };
  }
}

// The pane status line while a lease is involved; null leaves the viewer's own status alone.
export function leaseStatus(view: LeaseView, now: Date): string | null {
  if (view.state === "held" && view.expiresAt) {
    const left = Math.max(0, Math.ceil((Date.parse(view.expiresAt) - now.getTime()) / 60_000));
    return `Typing · your keys go to the session · ${left} min left`;
  }
  if (view.state === "confirm") return "Keys will go straight to the agent's terminal. Only one person can type at a time.";
  return view.note || null;
}

// A click on the typing button: what to do next. Keys are never sent from here.
export type LeaseStep = { view: LeaseView; request: null | { method: "POST"; body: { socket: string; minutes: number } } | { method: "DELETE" } };
export function onLeaseClick(view: LeaseView): LeaseStep {
  if (!view.socket) return { view, request: null };
  if (view.state === "off") return { view: { ...view, state: "confirm", note: "" }, request: null };
  if (view.state === "confirm") return { view: { ...view, state: "asking" }, request: { method: "POST", body: { socket: view.socket, minutes: LEASE_MINUTES } } };
  if (view.state === "held") return { view: { ...view, state: "releasing" }, request: { method: "DELETE" } };
  return { view, request: null };
}

// The host's answer to the POST or DELETE. A grant arrives as a frame on the socket too; whichever
// comes first moves the state, and keys wait for "held".
export function onLeaseAnswer(view: LeaseView, method: "POST" | "DELETE", status: number, body: unknown): LeaseView {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  if (method === "POST") {
    if (status === 201) {
      const until = text((body as { lease?: { expiresAt?: unknown } } | null)?.lease?.expiresAt, 40);
      return view.state === "held" || !until ? view : { ...view, state: "held", expiresAt: until, note: "" };
    }
    return { ...view, state: "off", note: `Not typing: ${text(message) ?? `host answered ${status}`}` };
  }
  if (status >= 200 && status < 300) return view.state === "releasing" ? { ...view, state: "off", expiresAt: null, note: "Typing stopped" } : view;
  return { ...view, state: view.state === "releasing" ? "held" : view.state, note: `Could not stop typing: ${text(message) ?? `host answered ${status}`}` };
}

export const mayType = (view: LeaseView) => view.state === "held";
