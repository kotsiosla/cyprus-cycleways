import type { StationSuggestion } from "@/lib/userSuggestions";
import { getRuntimeConfig } from "@/lib/runtimeConfig";

type EnvLike = Partial<Record<string, string>>;
const VITE_ENV: EnvLike = (import.meta as ImportMeta & { env?: EnvLike }).env ?? {};

// A public webhook/form endpoint (e.g. Formspree / Getform / Pipedream).
// It should be configured on the provider to email the admin privately.
const getAdminNotifyEndpoint = () => VITE_ENV.VITE_ADMIN_NOTIFY_ENDPOINT ?? getRuntimeConfig().adminNotifyEndpoint;

export type AdminNotifyResult = { ok: boolean; reason?: string };

export function isAdminNotifyConfigured(): boolean {
  return Boolean(getAdminNotifyEndpoint());
}

async function postJson(endpoint: string, body: unknown) {
  return await fetch(endpoint, {
    method: "POST",
    referrerPolicy: "no-referrer",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function postForm(endpoint: string, body: Record<string, string>) {
  const params = new URLSearchParams(body);
  return await fetch(endpoint, {
    method: "POST",
    referrerPolicy: "no-referrer",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: params.toString()
  });
}

export async function notifyAdminNewSuggestion(args: {
  approvalUrl: string;
  suggestion: StationSuggestion;
}): Promise<AdminNotifyResult> {
  const adminNotifyEndpoint = getAdminNotifyEndpoint();
  if (!adminNotifyEndpoint) {
    return { ok: false, reason: "admin_notify_endpoint_not_configured" };
  }

  const { approvalUrl, suggestion } = args;
  const [lon, lat] = suggestion.coordinates;

  const messageLines = [
    "New charging station suggestion",
    "",
    `Name: ${suggestion.name}`,
    suggestion.city ? `City: ${suggestion.city}` : null,
    typeof suggestion.powerKw === "number" ? `Power: ${suggestion.powerKw} kW` : null,
    suggestion.connectors?.length ? `Connectors: ${suggestion.connectors.join(", ")}` : null,
    `Coords: ${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    "",
    "Review / approve:",
    approvalUrl
  ].filter(Boolean) as string[];

  // Keep payload simple for broad compatibility with form/webhook providers.
  const body = {
    type: "station_suggestion",
    subject: "New EV charger suggestion (Cyprus)",
    approval_url: approvalUrl,
    name: suggestion.name,
    city: suggestion.city ?? "",
    power_kw: typeof suggestion.powerKw === "number" ? suggestion.powerKw : "",
    connectors: (suggestion.connectors ?? []).join(", "),
    coordinates: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    message: messageLines.join("\n")
  };

  try {
    const res = await postJson(adminNotifyEndpoint, body);
    if (res.ok) return { ok: true };

    // Some form providers only accept form-encoded payloads.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405 || res.status === 415) {
      const formRes = await postForm(adminNotifyEndpoint, Object.fromEntries(
        Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : String(v)])
      ));
      if (formRes.ok) return { ok: true };
      return { ok: false, reason: `http_${formRes.status}` };
    }

    return { ok: false, reason: `http_${res.status}` };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}
