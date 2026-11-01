/**
 * Build-time params for the dynamic project routes under `output: export`.
 *
 * A static export has to know its dynamic route params at build time. Cairn
 * project ids are runtime data, so ask the backend (when it is reachable at
 * build time) and degrade to an empty list otherwise: the normal server build
 * still renders any project id on demand.
 */
export async function staticProjectParams(): Promise<{ id: string }[]> {
  const base = process.env.CAIRN_API ?? "http://127.0.0.1:8000";
  try {
    const response = await fetch(`${base}/projects`, { cache: "no-store" });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" && id ? [{ id }] : [];
    });
  } catch {
    return [];
  }
}
