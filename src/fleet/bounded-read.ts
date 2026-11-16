// Reading a child's pipes until EOF is not enough: a descendant in another process group (ssh with
// ControlPersist calls setsid) survives the group kill and keeps the pipes open. So reads also stop
// a short grace after the child exited or was killed, and keep what arrived until then.
export const DRAIN_GRACE_MS = 1_000;

export function drainDeadline(graceMs = DRAIN_GRACE_MS) {
  let fire!: () => void;
  const reached = new Promise<void>((resolve) => { fire = resolve; });
  let armed = false;
  return {
    reached,
    arm() {
      if (armed) return;
      armed = true;
      setTimeout(fire, graceMs);
    },
  };
}

export type BoundedRead = { bytes: Uint8Array; overflow: boolean; cut: boolean };

// keepDraining: past the limit, keep reading and drop the bytes, so the writer is not cut off.
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  until: Promise<void>,
  options: { onOverflow?: () => void; keepDraining?: boolean } = {},
): Promise<BoundedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let overflow = false;
  let cut = false;
  const deadline = until.then(() => "cut" as const);
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "cut") { cut = true; break; }
      if (next.done) break;
      if (overflow) continue;
      if (length + next.value.byteLength > limit) {
        overflow = true;
        chunks.push(next.value.subarray(0, limit - length));
        length = limit;
        options.onOverflow?.();
        if (!options.keepDraining) break;
        continue;
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { bytes: Buffer.concat(chunks), overflow, cut };
}
