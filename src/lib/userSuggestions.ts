import type { ChargingStation } from "@/lib/chargingStations";

export type SuggestedConnector = "CCS" | "Type 2" | "CHAdeMO" | "Schuko" | "Type 1" | "Tesla";

export type StationSuggestion = {
  id: string;
  createdAt: number; // epoch ms
  coordinates: [number, number]; // [lon, lat]
  name: string;
  city?: string;
  address?: string;
  connectors: SuggestedConnector[];
  powerKw?: number;
  notes?: string;
  photoDataUrl?: string; // optional thumbnail-ish data URL
};

export type StoredSuggestions = {
  pending: StationSuggestion[];
  approved: StationSuggestion[];
};

const STORAGE_KEY = "station_suggestions_v1";

function safeParse(raw: string | null): StoredSuggestions {
  if (!raw) return { pending: [], approved: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSuggestions>;
    return {
      pending: Array.isArray(parsed.pending) ? (parsed.pending as StationSuggestion[]) : [],
      approved: Array.isArray(parsed.approved) ? (parsed.approved as StationSuggestion[]) : []
    };
  } catch {
    return { pending: [], approved: [] };
  }
}

function readStore(): StoredSuggestions {
  if (typeof localStorage === "undefined") return { pending: [], approved: [] };
  return safeParse(localStorage.getItem(STORAGE_KEY));
}

function writeStore(store: StoredSuggestions) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota
  }
}

function genId() {
  return `s_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function listPendingSuggestions(): StationSuggestion[] {
  return readStore().pending.sort((a, b) => b.createdAt - a.createdAt);
}

export function listApprovedSuggestions(): StationSuggestion[] {
  return readStore().approved.sort((a, b) => b.createdAt - a.createdAt);
}

export function addPendingSuggestion(input: Omit<StationSuggestion, "id" | "createdAt">): StationSuggestion {
  const store = readStore();
  const suggestion: StationSuggestion = { ...input, id: genId(), createdAt: Date.now() };
  store.pending.push(suggestion);
  store.pending = store.pending.slice(-500);
  writeStore(store);
  return suggestion;
}

export function approveSuggestion(id: string) {
  const store = readStore();
  const idx = store.pending.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const [item] = store.pending.splice(idx, 1);
  store.approved.push(item);
  store.approved = store.approved.slice(-2000);
  writeStore(store);
  return item;
}

export function rejectSuggestion(id: string) {
  const store = readStore();
  store.pending = store.pending.filter((s) => s.id !== id);
  writeStore(store);
}

export function removeApprovedSuggestion(id: string) {
  const store = readStore();
  store.approved = store.approved.filter((s) => s.id !== id);
  writeStore(store);
}

export function suggestionToChargingStation(s: StationSuggestion): ChargingStation {
  const connectors = s.connectors?.length ? s.connectors : undefined;
  return {
    id: `user/${s.id}`,
    name: s.name,
    operator: "User submitted",
    address: s.address,
    city: s.city,
    connectors,
    power: typeof s.powerKw === "number" ? `${s.powerKw} kW` : undefined,
    availability: "unknown",
    statusLabel: "User suggested (unverified)",
    coordinates: s.coordinates,
    // extra optional metadata (non-breaking)
    isUserSuggested: true,
    suggestionId: s.id,
    suggestionPhotoDataUrl: s.photoDataUrl,
    suggestionNotes: s.notes,
    suggestionCreatedAt: s.createdAt
  } as ChargingStation;
}

// --- Share/import helpers (no backend) ---
function toBase64Url(text: string) {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(b64url: string) {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const text = decodeURIComponent(escape(atob(padded)));
  return text;
}

export function makeSuggestionShareUrl(s: StationSuggestion, baseUrl?: string): string {
  // IMPORTANT: Do not embed sensitive/untrusted fields in URLs.
  // - URLs leak via browser history, logs, screenshots, link previews, etc.
  // - Query params can also leak via referrers if not locked down.
  // Keep payload minimal and do not include photo/notes.
  const shareable = {
    v: 1,
    suggestion: {
      coordinates: s.coordinates,
      name: s.name,
      city: s.city,
      address: s.address,
      connectors: s.connectors,
      powerKw: s.powerKw
    }
  };
  const payload = toBase64Url(JSON.stringify(shareable));
  const origin = baseUrl ?? (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
  return `${origin}?importSuggestion=${payload}`;
}

export function makeSuggestionApprovalUrl(s: StationSuggestion, baseUrl?: string): string {
  // Same as share URL, but named to match admin workflow.
  // Admin approval is an *in-app action* and must not be controlled by URL params.
  const shareable = {
    v: 1,
    suggestion: {
      coordinates: s.coordinates,
      name: s.name,
      city: s.city,
      address: s.address,
      connectors: s.connectors,
      powerKw: s.powerKw
    }
  };
  const payload = toBase64Url(JSON.stringify(shareable));
  const origin = baseUrl ?? (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
  return `${origin}?importSuggestion=${payload}`;
}

export function importSuggestionFromUrlParam(payload: string): StationSuggestion | null {
  try {
    const decoded = fromBase64Url(payload);
    const parsed = JSON.parse(decoded) as { v?: number; suggestion?: unknown };
    const suggestion = parsed?.suggestion;
    if (!suggestion || typeof suggestion !== "object") return null;
    const s = suggestion as Record<string, unknown>;
    const coords = s.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

    const clamp = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
    const nameRaw = typeof s.name === "string" ? s.name : "User suggested station";
    const name = clamp(nameRaw.trim() || "User suggested station", 120);

    const city = typeof s.city === "string" ? clamp(s.city.trim(), 80) : undefined;
    const address = typeof s.address === "string" ? clamp(s.address.trim(), 200) : undefined;

    const allowedConnectors: SuggestedConnector[] = ["CCS", "Type 2", "CHAdeMO", "Schuko", "Type 1", "Tesla"];
    const allowedSet = new Set<string>(allowedConnectors);
    const connectorsRaw = Array.isArray(s.connectors) ? s.connectors : [];
    const connectors = connectorsRaw
      .filter((c): c is string => typeof c === "string" && allowedSet.has(c))
      .slice(0, 10) as SuggestedConnector[];

    const powerKwRaw = typeof s.powerKw === "number" ? s.powerKw : undefined;
    const powerKw =
      typeof powerKwRaw === "number" && Number.isFinite(powerKwRaw) && powerKwRaw > 0 && powerKwRaw <= 1000
        ? powerKwRaw
        : undefined;

    // Never import photo/notes from URLs (risk: XSS, PII leakage, huge URLs).
    const normalized: Omit<StationSuggestion, "id" | "createdAt"> = {
      coordinates: [lon, lat],
      name,
      city: city || undefined,
      address: address || undefined,
      connectors,
      powerKw
    };
    return addPendingSuggestion(normalized);
  } catch {
    return null;
  }
}

