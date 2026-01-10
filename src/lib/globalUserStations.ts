import type { StationSuggestion, SuggestedConnector } from "@/lib/userSuggestions";

type GlobalApprovedStationV2 = {
  id: string;
  coordinates: [number, number]; // [lon, lat]
  name: string;
  city?: string;
  address?: string;
  connectors: SuggestedConnector[];
  powerKw?: number;
};

type GlobalUserStationsV2 = {
  v: 2;
  approved: GlobalApprovedStationV2[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clamp(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isValidCoords(coords: unknown): coords is [number, number] {
  return (
    Array.isArray(coords) &&
    coords.length === 2 &&
    isFiniteNumber(coords[0]) &&
    isFiniteNumber(coords[1]) &&
    coords[0] >= -180 &&
    coords[0] <= 180 &&
    coords[1] >= -90 &&
    coords[1] <= 90
  );
}

function sanitizeConnectors(value: unknown): SuggestedConnector[] {
  const allowed: SuggestedConnector[] = ["CCS", "Type 2", "CHAdeMO", "Schuko", "Type 1", "Tesla"];
  const allowedSet = new Set<string>(allowed);
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is string => typeof c === "string" && allowedSet.has(c))
    .slice(0, 10) as SuggestedConnector[];
}

function sanitizeGlobalStationV2(value: unknown): GlobalApprovedStationV2 | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) return null;
  if (!isValidCoords(value.coordinates)) return null;
  const nameRaw = typeof value.name === "string" ? value.name : "";
  const name = clamp(nameRaw.trim() || "User suggested station", 120);
  const city = typeof value.city === "string" ? clamp(value.city.trim(), 80) : undefined;
  const address = typeof value.address === "string" ? clamp(value.address.trim(), 200) : undefined;
  const connectors = sanitizeConnectors(value.connectors);
  const powerKw =
    isFiniteNumber(value.powerKw) && value.powerKw > 0 && value.powerKw <= 1000 ? value.powerKw : undefined;
  return { id, coordinates: value.coordinates, name, city: city || undefined, address: address || undefined, connectors, powerKw };
}

function safeParseGlobal(payload: unknown): GlobalUserStationsV2 {
  if (!isRecord(payload)) return { v: 2, approved: [] };
  const v = payload.v;
  const approvedRaw = payload.approved;
  const approvedList = Array.isArray(approvedRaw) ? approvedRaw : [];

  // v2: expected schema (sanitized).
  if (v === 2) {
    const approved = approvedList.map(sanitizeGlobalStationV2).filter(Boolean) as GlobalApprovedStationV2[];
    return { v: 2, approved };
  }

  // v1 (legacy): array of StationSuggestion-like objects. Sanitize and drop sensitive fields.
  const approved = approvedList
    .map((item) => {
      if (!isRecord(item)) return null;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) return null;
      if (!isValidCoords(item.coordinates)) return null;
      const nameRaw = typeof item.name === "string" ? item.name : "";
      const name = clamp(nameRaw.trim() || "User suggested station", 120);
      const city = typeof item.city === "string" ? clamp(item.city.trim(), 80) : undefined;
      const address = typeof item.address === "string" ? clamp(item.address.trim(), 200) : undefined;
      const connectors = sanitizeConnectors(item.connectors);
      const powerKw =
        isFiniteNumber(item.powerKw) && item.powerKw > 0 && item.powerKw <= 1000 ? item.powerKw : undefined;
      return { id, coordinates: item.coordinates, name, city: city || undefined, address: address || undefined, connectors, powerKw };
    })
    .filter(Boolean) as GlobalApprovedStationV2[];

  return { v: 2, approved };
}

export async function fetchGlobalApprovedSuggestions(): Promise<StationSuggestion[]> {
  // Served from /public so it can be updated via repo commits (Option A).
  const url = `${import.meta.env.BASE_URL}user-stations.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    const parsed = safeParseGlobal(json);
    // Return as StationSuggestion for compatibility with existing UI, but with sensitive fields stripped.
    return parsed.approved.map((s) => ({
      id: s.id,
      createdAt: 0,
      coordinates: s.coordinates,
      name: s.name,
      city: s.city,
      address: s.address,
      connectors: s.connectors,
      powerKw: s.powerKw
    }));
  } catch {
    return [];
  }
}

export function buildGlobalUserStationsFile(approved: StationSuggestion[]): GlobalUserStationsV2 {
  const sanitized: GlobalApprovedStationV2[] = approved
    .map((s) => sanitizeGlobalStationV2({
      id: s.id,
      coordinates: s.coordinates,
      name: s.name,
      city: s.city,
      address: s.address,
      connectors: s.connectors,
      powerKw: s.powerKw
    }))
    .filter(Boolean) as GlobalApprovedStationV2[];
  return { v: 2, approved: sanitized };
}

