// One queue per gateway config file, shared by everything in this process that rewrites it (adding a host,
// removing one), so two read-change-write steps never interleave and lose an update.
import { resolve } from "node:path";

const queues = new Map<string, Promise<unknown>>();

export function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(configPath);
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}
