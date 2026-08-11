export function parseId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null
  return Number(raw)
}
