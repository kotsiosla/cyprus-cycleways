import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useIsMobile } from "@/hooks/use-mobile";
import { ChevronDown, ImagePlus, Loader2, Trash2, X } from "lucide-react";
import type { SuggestedConnector, StationSuggestion } from "@/lib/userSuggestions";
import { addPendingSuggestion, makeSuggestionApprovalUrl } from "@/lib/userSuggestions";
import { isAdminNotifyConfigured, notifyAdminNewSuggestion } from "@/lib/adminNotify";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coordinates: [number, number] | null;
};

const CONNECTOR_OPTIONS: SuggestedConnector[] = ["CCS", "Type 2", "CHAdeMO", "Schuko", "Type 1", "Tesla"];

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

export default function SuggestStationDialog({ open, onOpenChange, coordinates }: Props) {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [powerKw, setPowerKw] = useState("");
  const [notes, setNotes] = useState("");
  const [connectors, setConnectors] = useState<SuggestedConnector[]>([]);
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMobile = useIsMobile();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const notifyConfigured = isAdminNotifyConfigured();

  useEffect(() => {
    if (open) setDetailsOpen(!isMobile);
  }, [open, isMobile]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const coordsLabel = useMemo(() => {
    if (!coordinates) return null;
    return `${coordinates[1].toFixed(5)}, ${coordinates[0].toFixed(5)}`;
  }, [coordinates]);

  const reset = () => {
    setName("");
    setCity("");
    setAddress("");
    setPowerKw("");
    setNotes("");
    setConnectors([]);
    setPhotoDataUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const toggleConnector = (c: SuggestedConnector) => {
    setConnectors((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const handleSubmit = async () => {
    if (busy) return;
    if (!coordinates) {
      toast.error("Pick a location on the map first.");
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Please enter a station name.");
      return;
    }
    setBusy(true);
    try {
      const power = Number(powerKw);
      const powerNum = Number.isFinite(power) && power > 0 ? power : undefined;
      const payload: Omit<StationSuggestion, "id" | "createdAt"> = {
        coordinates,
        name: trimmed,
        city: city.trim() || undefined,
        address: address.trim() || undefined,
        connectors,
        powerKw: powerNum,
        notes: notes.trim() || undefined,
        photoDataUrl: photoDataUrl ?? undefined
      };
      const suggestion = addPendingSuggestion(payload);
      const approvalUrl = makeSuggestionApprovalUrl(suggestion);

      const notify = await notifyAdminNewSuggestion({ approvalUrl, suggestion });
      try {
        await navigator.clipboard.writeText(approvalUrl);
      } catch {
        // ok
      }

      if (notify.ok) {
        toast.success("Submitted!", {
          description:
            notify.reason === "opaque_no_cors"
              ? "Notification sent (unverified). Approval link copied."
              : "Sent to admin for approval. Approval link copied."
        });
      } else {
        toast.message("Suggestion saved", {
          description:
            notify.reason === "admin_notify_endpoint_not_configured"
              ? "Email notifications are not configured for this deployment. Approval link copied—send it to the admin."
              : "Could not notify admin automatically. Approval link copied—send it to the admin."
        });
      }

      reset();
      onOpenChange(false);
    } catch {
      toast.error("Failed to submit suggestion.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      className={[
        "absolute z-20 rounded-xl border bg-background/95 backdrop-blur shadow-soft pointer-events-auto overflow-hidden flex flex-col",
        isMobile ? "left-3 right-3 bottom-3 max-h-[62vh]" : "left-4 top-4 w-[400px] max-h-[72vh]"
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b bg-background/60">
        <div className="min-w-0">
          <div className="text-base font-semibold">Suggest a new charging station</div>
          <div className="text-xs text-muted-foreground">Reviewed by admin before appearing on the map.</div>
        </div>
        <button
          type="button"
          className="rounded-md p-2 hover:bg-muted"
          aria-label="Close"
          onClick={() => {
            reset();
            onOpenChange(false);
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 pt-3 pb-4 overflow-y-auto flex-1">
        <div className="space-y-4">
          {!notifyConfigured ? (
            <Alert className="bg-muted/20">
              <AlertTitle>Email notification not configured</AlertTitle>
              <AlertDescription>
                This site is static, so it can’t send email by itself. When you submit, we’ll copy an approval link that
                you can send to the admin (or configure <code>VITE_ADMIN_NOTIFY_ENDPOINT</code> in GitHub Actions secrets
                to a webhook provider that forwards to your inbox).
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground flex items-center justify-between gap-2">
            <div className="font-medium text-foreground">Location</div>
            <div className="font-mono">{coordsLabel ?? "Drag pin to set"}</div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marina Fast Charge" />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Connectors</p>
            <div className="grid gap-2 grid-cols-2">
              {CONNECTOR_OPTIONS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={connectors.includes(c)} onCheckedChange={() => toggleConnector(c)} />
                  <span>{c}</span>
                </label>
              ))}
            </div>
          </div>

          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-sm"
              >
                <span className="text-sm font-medium">More details (optional)</span>
                <ChevronDown className={`h-4 w-4 transition ${detailsOpen ? "rotate-180" : ""}`} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">City</label>
                  <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Limassol" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Max power (kW)</label>
                  <Input
                    value={powerKw}
                    onChange={(e) => setPowerKw(e.target.value)}
                    inputMode="numeric"
                    type="number"
                    min={1}
                    placeholder="e.g. 150"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <label className="text-xs text-muted-foreground">Address</label>
                  <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, landmark…" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Notes</label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything helpful (access, parking, issues)…"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Photo</label>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 1_500_000) {
                        toast.error("Image too large. Please upload a smaller photo (<1.5MB).");
                        return;
                      }
                      setBusy(true);
                      try {
                        const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
                        if (file.type && !allowedTypes.has(file.type)) {
                          toast.error("Unsupported image format. Please upload PNG/JPG/WebP/GIF.");
                          return;
                        }
                        const dataUrl = await fileToDataUrl(file);
                        // Hard block SVG-in-data-URL and other non-image payloads.
                        // (Even when rendered as <img>, SVG/data URLs can be abused in some contexts.)
                        if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(dataUrl)) {
                          toast.error("Unsupported image format. Please upload PNG/JPG/WebP/GIF.");
                          return;
                        }
                        setPhotoDataUrl(dataUrl);
                      } catch {
                        toast.error("Failed to load image.");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                    {photoDataUrl ? "Replace photo" : "Upload photo"}
                  </Button>
                  {photoDataUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Remove photo"
                      onClick={() => setPhotoDataUrl(null)}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                {photoDataUrl ? (
                  <img src={photoDataUrl} alt="Suggestion preview" className="rounded-lg border max-h-32 object-cover" />
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      <div className="px-4 py-3 border-t bg-background/60">
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={busy || !coordinates || !name.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}

