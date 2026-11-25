export type WorkstationProfile = { group: string; description: string; defaultHarness: "claude-code" | "deepseek-harness" | null };

export function parseWorkstationProfile(value: unknown): WorkstationProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["group", "description", "defaultHarness"].includes(key))) return null;
  const { group, description, defaultHarness } = p;
  if (typeof group !== "string" || !group.trim() || group.length > 40 || typeof description !== "string" || description.length > 160) return null;
  if (/[\x00-\x1f\x7f]/.test(group + description) || !group.isWellFormed() || !description.isWellFormed()) return null;
  if (defaultHarness !== null && defaultHarness !== "claude-code" && defaultHarness !== "deepseek-harness") return null;
  return { group: group.trim(), description: description.trim(), defaultHarness };
}
