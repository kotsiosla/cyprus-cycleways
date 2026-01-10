import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Crosshair, Home, MapPinPlus, Search, Share2, SlidersHorizontal, Users, X, ZoomIn, ZoomOut } from "lucide-react";
import { ChargingStation } from "@/lib/chargingStations";
import type { FeatureCollection, Feature, LineString, Point } from "geojson";
import { Input } from "@/components/ui/input";
import SuggestStationDialog from "@/components/SuggestStationDialog";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ChargingStationMapProps {
  stations: ChargingStation[];
  selectedStation?: ChargingStation | null;
  onStationSelect?: (station: ChargingStation) => void;
  onRequestLocation?: () => void;
  userLocation?: [number, number] | null;
  routePolyline?: [number, number][] | null;
  highlightStationIds?: string[];
}

const defaultView = {
  center: [33.3823, 35.1856] as [number, number],
  zoom: 8.2
};

// OpenChargeMap uses an OpenFreeMap basemap (OpenMapTiles + OpenStreetMap).
// This keeps our map consistent with the OpenChargeMap look & attribution.
const mapStyleUrl = "https://tiles.openfreemap.org/styles/liberty";

const stationLayerIds = ["clusters", "cluster-count", "unclustered-point", "selected-station"] as const;
const userStationLayerIds = ["user-stations-point", "user-selected-station"] as const;

export default function ChargingStationMap({
  stations,
  selectedStation,
  onStationSelect,
  onRequestLocation,
  userLocation,
  routePolyline,
  highlightStationIds
}: ChargingStationMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const stationsRef = useRef<ChargingStation[]>(stations);
  const [showStations, setShowStations] = useState(true);
  const [showUserStations, setShowUserStations] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestCoords, setSuggestCoords] = useState<[number, number] | null>(null);
  const suggestMarkerRef = useRef<maplibregl.Marker | null>(null);

  const officialStations = useMemo(() => stations.filter((s) => !s.isUserSuggested), [stations]);
  const userSuggestedStations = useMemo(() => stations.filter((s) => s.isUserSuggested), [stations]);

  const smartSearchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];

    const parseNumber = () => {
      const m = q.match(/(\d+(?:\.\d+)?)/);
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    };
    const numberToken = parseNumber();

    const normalize = (s?: string) => (s ?? "").toLowerCase();
    const scoreStation = (s: ChargingStation) => {
      const name = normalize(s.name);
      const city = normalize(s.city);
      const addr = normalize(s.address);
      const operator = normalize(s.operator);
      const connectors = (s.connectors ?? []).map(normalize);

      let score = 0;
      if (name.startsWith(q)) score += 60;
      else if (name.includes(q)) score += 35;
      if (city.includes(q)) score += 18;
      if (addr.includes(q)) score += 14;
      if (operator.includes(q)) score += 10;
      if (connectors.some((c) => c.includes(q))) score += 18;

      if (q.includes("ccs") && connectors.some((c) => c.includes("ccs"))) score += 12;
      if (q.includes("type 2") && connectors.some((c) => c.includes("type 2"))) score += 12;
      if (q.includes("chademo") && connectors.some((c) => c.includes("chademo"))) score += 12;

      if (numberToken !== null) {
        const powerText = s.power ?? "";
        const match = powerText.match(/([\d.]+)/);
        const powerKw = match ? Number(match[1]) : null;
        if (powerKw && Number.isFinite(powerKw) && powerKw >= numberToken) score += 10;
      }
      return score;
    };

    const haversineKm = (from: [number, number], to: [number, number]) => {
      const toRad = (value: number) => (value * Math.PI) / 180;
      const [fromLng, fromLat] = from;
      const [toLng, toLat] = to;
      const earthRadiusKm = 6371;
      const dLat = toRad(toLat - fromLat);
      const dLng = toRad(toLng - fromLng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return earthRadiusKm * c;
    };

    const results = stations
      .map((s) => ({
        station: s,
        score: scoreStation(s),
        distanceKm: userLocation ? haversineKm(userLocation, s.coordinates) : null
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
        return a.station.name.localeCompare(b.station.name);
      })
      .slice(0, 10);

    return results;
  }, [searchQuery, stations, userLocation]);

  const routeLineGeoJson = useMemo(() => {
    if (!routePolyline || routePolyline.length < 2) {
      return { type: "FeatureCollection", features: [] } satisfies FeatureCollection<LineString>;
    }
    const feature: Feature<LineString> = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: routePolyline },
      properties: {}
    };
    return { type: "FeatureCollection", features: [feature] } satisfies FeatureCollection<LineString>;
  }, [routePolyline]);

  const routeAnchorsGeoJson = useMemo(() => {
    if (!routePolyline || routePolyline.length < 2) {
      return { type: "FeatureCollection", features: [] } satisfies FeatureCollection<Point, { kind: string }>;
    }
    const start = routePolyline[0];
    const end = routePolyline[routePolyline.length - 1];
    const features: Array<Feature<Point, { kind: string }>> = [
      { type: "Feature", geometry: { type: "Point", coordinates: start }, properties: { kind: "start" } },
      { type: "Feature", geometry: { type: "Point", coordinates: end }, properties: { kind: "end" } }
    ];
    return { type: "FeatureCollection", features } satisfies FeatureCollection<Point, { kind: string }>;
  }, [routePolyline]);

  const routeStopsGeoJson = useMemo(() => {
    const ids = new Set(highlightStationIds ?? []);
    if (!ids.size) {
      return { type: "FeatureCollection", features: [] } satisfies FeatureCollection<
        Point,
        { id: string; name: string }
      >;
    }
    const features: Array<Feature<Point, { id: string; name: string }>> = stations
      .filter((s) => ids.has(s.id))
      .map((station) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: station.coordinates },
        properties: { id: station.id, name: station.name }
      }));
    return { type: "FeatureCollection", features } satisfies FeatureCollection<Point, { id: string; name: string }>;
  }, [stations, highlightStationIds]);

  const stationGeoJson = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: officialStations
        .filter((station) => station.coordinates)
        .map((station) => ({
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: station.coordinates
          },
          properties: {
            id: station.id,
            name: station.name,
            address: station.address ?? "",
            openingHours: station.openingHours ?? "",
            availability: station.availability ?? "unknown",
            statusLabel: station.statusLabel ?? "Status unknown"
          }
        }))
    };
  }, [officialStations]);

  const userStationGeoJson = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: userSuggestedStations
        .filter((station) => station.coordinates)
        .map((station) => ({
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: station.coordinates
          },
          properties: {
            id: station.id,
            name: station.name,
            address: station.address ?? "",
            statusLabel: station.statusLabel ?? "User suggested (unverified)"
          }
        }))
    };
  }, [userSuggestedStations]);

  useEffect(() => {
    stationsRef.current = stations;
  }, [stations]);

  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyleUrl,
      center: defaultView.center,
      zoom: defaultView.zoom
    });

    mapRef.current = map;

    map.on("load", () => {
      if (map.getSource("stations")) return;

      map.addSource("stations", {
        type: "geojson",
        data: stationGeoJson,
        cluster: true,
        clusterMaxZoom: 13,
        clusterRadius: 50
      });

      map.addSource("user-stations", {
        type: "geojson",
        data: userStationGeoJson
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "stations",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#60a5fa", 20, "#2563eb", 50, "#1e3a8a"],
          "circle-radius": ["step", ["get", "point_count"], 18, 20, 24, 50, 30],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0f172a"
        }
      });

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "stations",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 12
        },
        paint: { "text-color": "#f8fafc" }
      });

      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: "stations",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": [
            "match",
            ["get", "availability"],
            "available",
            "#16a34a",
            "occupied",
            "#f59e0b",
            "out_of_service",
            "#ef4444",
            "#64748b"
          ],
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0f172a"
        }
      });

      map.addLayer({
        id: "selected-station",
        type: "circle",
        source: "stations",
        filter: ["==", ["get", "id"], ""],
        paint: {
          "circle-color": "#0f172a",
          "circle-radius": 10,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#f8fafc"
        }
      });

      map.addLayer({
        id: "user-stations-point",
        type: "circle",
        source: "user-stations",
        paint: {
          "circle-color": "#a855f7",
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#f8fafc"
        }
      });

      map.addLayer({
        id: "user-selected-station",
        type: "circle",
        source: "user-stations",
        filter: ["==", ["get", "id"], ""],
        paint: {
          "circle-color": "#0f172a",
          "circle-radius": 10,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#a855f7"
        }
      });

      // Route overlay sources/layers (optional).
      if (!map.getSource("route-line")) {
        map.addSource("route-line", { type: "geojson", data: routeLineGeoJson });
        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route-line",
          paint: {
            "line-color": "#22c55e",
            "line-width": 4,
            "line-opacity": 0.85
          }
        });
      }

      if (!map.getSource("route-anchors")) {
        map.addSource("route-anchors", { type: "geojson", data: routeAnchorsGeoJson });
        map.addLayer({
          id: "route-anchors",
          type: "circle",
          source: "route-anchors",
          paint: {
            "circle-color": [
              "match",
              ["get", "kind"],
              "start",
              "#0ea5e9",
              "end",
              "#8b5cf6",
              "#64748b"
            ],
            "circle-radius": 7,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#0f172a"
          }
        });
      }

      if (!map.getSource("route-stops")) {
        map.addSource("route-stops", { type: "geojson", data: routeStopsGeoJson });
        map.addLayer({
          id: "route-stops",
          type: "circle",
          source: "route-stops",
          paint: {
            "circle-color": "#f97316",
            "circle-radius": 7,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#0f172a"
          }
        });
      }

      map.on("click", "route-stops", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const stationId = String(feature.properties?.id ?? "");
        const station = stationsRef.current.find((item) => item.id === stationId);
        if (station) onStationSelect?.(station);
      });

      map.on("click", "clusters", (event) => {
        const features = map.queryRenderedFeatures(event.point, { layers: ["clusters"] });
        const clusterId = features[0]?.properties?.cluster_id;
        const source = map.getSource("stations") as maplibregl.GeoJSONSource | undefined;
        if (!source || clusterId === undefined) return;

        source.getClusterExpansionZoom(clusterId).then((zoom) => {
          const [longitude, latitude] = (features[0].geometry as GeoJSON.Point)
            .coordinates as [number, number];
          map.easeTo({ center: [longitude, latitude], zoom });
        }).catch(() => {});
      });

      map.on("click", "unclustered-point", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const stationId = String(feature.properties?.id ?? "");
        const station = stationsRef.current.find((item) => item.id === stationId);
        if (station) onStationSelect?.(station);
      });

      map.on("click", "user-stations-point", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const stationId = String(feature.properties?.id ?? "");
        const station = stationsRef.current.find((item) => item.id === stationId);
        if (station) onStationSelect?.(station);
      });

      map.on("mouseenter", "clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "clusters", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "unclustered-point", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "unclustered-point", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "user-stations-point", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "user-stations-point", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("mouseenter", "route-stops", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "route-stops", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;

      userMarkerRef.current?.remove();
      userMarkerRef.current = null;

      map.remove();
      mapRef.current = null;
    };
    // Intentionally run once: map lifecycle is managed manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource("stations") as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(stationGeoJson);
    }
    const userSource = map.getSource("user-stations") as maplibregl.GeoJSONSource | undefined;
    if (userSource) {
      userSource.setData(userStationGeoJson);
    }

    const routeLineSource = map.getSource("route-line") as maplibregl.GeoJSONSource | undefined;
    if (routeLineSource) routeLineSource.setData(routeLineGeoJson);
    const anchorsSource = map.getSource("route-anchors") as maplibregl.GeoJSONSource | undefined;
    if (anchorsSource) anchorsSource.setData(routeAnchorsGeoJson);
    const stopsSource = map.getSource("route-stops") as maplibregl.GeoJSONSource | undefined;
    if (stopsSource) stopsSource.setData(routeStopsGeoJson);

    if (routePolyline && routePolyline.length >= 2) {
      const bounds = new maplibregl.LngLatBounds(routePolyline[0], routePolyline[0]);
      for (const coord of routePolyline) bounds.extend(coord);
      map.fitBounds(bounds, {
        padding: 60,
        duration: 900,
        maxZoom: 12.5
      });
    }

    if (userLocation) {
      if (!userMarkerRef.current) {
        const userMarker = document.createElement("div");
        userMarker.className = "user-marker";
        userMarkerRef.current = new maplibregl.Marker({ element: userMarker })
          .setLngLat(userLocation)
          .addTo(map);
      } else {
        userMarkerRef.current.setLngLat(userLocation);
      }
    } else if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
  }, [
    stationGeoJson,
    userStationGeoJson,
    userLocation,
    routeLineGeoJson,
    routeAnchorsGeoJson,
    routeStopsGeoJson,
    routePolyline
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const visibility = showStations ? "visible" : "none";
    stationLayerIds.forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
    });
  }, [showStations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const visibility = showUserStations ? "visible" : "none";
    userStationLayerIds.forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", visibility);
      }
    });
  }, [showUserStations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const selectedIsUser = Boolean(selectedStation?.isUserSuggested);
    const selectedVisible = selectedIsUser ? showUserStations : showStations;

    if (!selectedStation || !selectedVisible) {
      if (map.getLayer("selected-station")) {
        map.setFilter("selected-station", ["==", ["get", "id"], ""]);
      }
      if (map.getLayer("user-selected-station")) {
        map.setFilter("user-selected-station", ["==", ["get", "id"], ""]);
      }
      popupRef.current?.remove();
      popupRef.current = null;
      return;
    }

    map.flyTo({ center: selectedStation.coordinates, zoom: 12.5, speed: 1.2 });
    if (!selectedIsUser && map.getLayer("selected-station")) {
      map.setFilter("selected-station", ["==", ["get", "id"], selectedStation.id]);
      if (map.getLayer("user-selected-station")) {
        map.setFilter("user-selected-station", ["==", ["get", "id"], ""]);
      }
    }
    if (selectedIsUser && map.getLayer("user-selected-station")) {
      map.setFilter("user-selected-station", ["==", ["get", "id"], selectedStation.id]);
      if (map.getLayer("selected-station")) {
        map.setFilter("selected-station", ["==", ["get", "id"], ""]);
      }
    }

    const availabilityLabel =
      selectedStation.statusLabel && selectedStation.statusLabel !== "Status unknown"
        ? selectedStation.statusLabel
        : selectedStation.availability === "available"
          ? "Available"
          : selectedStation.availability === "occupied"
            ? "Occupied"
            : selectedStation.availability === "out_of_service"
              ? "Out of service"
              : "Status unknown";

    const directionsUrl = (() => {
      const [lon, lat] = selectedStation.coordinates;
      const params = new URLSearchParams({
        api: "1",
        destination: `${lat},${lon}`,
        travelmode: "driving"
      });
      if (userLocation) {
        params.set("origin", `${userLocation[1]},${userLocation[0]}`);
      }
      return `https://www.google.com/maps/dir/?${params.toString()}`;
    })();

    popupRef.current?.remove();
    const container = document.createElement("div");
    container.style.maxWidth = "260px";

    const addLine = (text: string, className?: string) => {
      const div = document.createElement("div");
      if (className) div.className = className;
      div.textContent = text;
      container.appendChild(div);
      return div;
    };

    const addSection = (title: string) => {
      const wrap = document.createElement("div");
      wrap.className = "text-xs mt-2";
      const h = document.createElement("div");
      h.className = "font-medium mb-1";
      h.textContent = title;
      wrap.appendChild(h);
      container.appendChild(wrap);
      return wrap;
    };

    addLine(selectedStation.name, "text-sm font-semibold");
    if (selectedStation.osmName) addLine(`OSM: ${selectedStation.osmName}`, "text-xs text-muted-foreground");
    if (selectedStation.placeToPlugName) addLine(`PlaceToPlug: ${selectedStation.placeToPlugName}`, "text-xs text-muted-foreground");
    if (selectedStation.ocmName) addLine(`OpenChargeMap: ${selectedStation.ocmName}`, "text-xs text-muted-foreground");
    if (selectedStation.address) addLine(selectedStation.address, "text-xs text-muted-foreground");
    addLine(availabilityLabel, "text-xs mt-1");

    // Directions link (safe DOM creation; no HTML interpolation)
    {
      const wrap = document.createElement("div");
      wrap.className = "text-xs mt-2";
      const a = document.createElement("a");
      a.textContent = "Directions";
      a.href = directionsUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "inline-block";
      a.style.padding = "6px 10px";
      a.style.borderRadius = "8px";
      a.style.border = "1px solid rgba(148,163,184,0.6)";
      a.style.textDecoration = "none";
      wrap.appendChild(a);
      container.appendChild(wrap);
    }

    if (selectedStation.ports?.length) {
      const section = addSection("Ports");
      const list = document.createElement("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "4px";
      selectedStation.ports.slice(0, 6).forEach((port, idx) => {
        const parts = [
          `Port ${idx + 1}`,
          port.connectorLabel,
          typeof port.powerKw === "number" ? `${port.powerKw} kW` : undefined,
          port.availability === "available"
            ? "Available"
            : port.availability === "occupied"
              ? "In use"
              : port.availability === "out_of_service"
                ? "Out of service"
                : "Unknown"
        ].filter(Boolean) as string[];
        const row = document.createElement("div");
        row.textContent = parts.join(" · ");
        list.appendChild(row);
      });
      if (selectedStation.ports.length > 6) {
        const more = document.createElement("div");
        more.textContent = `+${selectedStation.ports.length - 6} more`;
        list.appendChild(more);
      }
      section.appendChild(list);
    }

    if (selectedStation.isUserSuggested && selectedStation.suggestionNotes) {
      const section = addSection("User notes");
      const div = document.createElement("div");
      div.style.opacity = "0.9";
      div.textContent = String(selectedStation.suggestionNotes);
      section.appendChild(div);
    }

    if (selectedStation.isUserSuggested && selectedStation.suggestionPhotoDataUrl) {
      const value = String(selectedStation.suggestionPhotoDataUrl);
      const isSafeDataUrl =
        /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= 2_500_000;
      if (isSafeDataUrl) {
        const wrap = document.createElement("div");
        wrap.className = "text-xs mt-2";
        const img = document.createElement("img");
        img.src = value;
        img.alt = "User photo";
        img.style.width = "100%";
        img.style.maxHeight = "140px";
        img.style.objectFit = "cover";
        img.style.borderRadius = "10px";
        img.style.border = "1px solid rgba(148,163,184,0.6)";
        wrap.appendChild(img);
        container.appendChild(wrap);
      }
    }

    if (selectedStation.ocm) {
      const section = addSection("Related information");
      const list = document.createElement("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "4px";
      if (selectedStation.ocm.usageType || selectedStation.ocm.isMembershipRequired !== undefined) {
        const div = document.createElement("div");
        div.textContent = `${selectedStation.ocm.usageType ?? "Access"}${
          selectedStation.ocm.isMembershipRequired ? " · Membership required" : ""
        }`;
        list.appendChild(div);
      }
      if (selectedStation.ocm.openingTimes) {
        const div = document.createElement("div");
        div.textContent = `Opening hours: ${selectedStation.ocm.openingTimes}`;
        list.appendChild(div);
      }
      if (selectedStation.ocm.usageCost) {
        const div = document.createElement("div");
        div.textContent = `Cost: ${selectedStation.ocm.usageCost}`;
        list.appendChild(div);
      }
      {
        const div = document.createElement("div");
        div.textContent = "Data: OpenChargeMap (CC BY 4.0)";
        list.appendChild(div);
      }
      section.appendChild(list);
    }

    if (selectedStation.openingHours) {
      addLine(selectedStation.openingHours, "text-xs text-muted-foreground");
    }

    popupRef.current = new maplibregl.Popup({ offset: 20 })
      .setLngLat(selectedStation.coordinates)
      .setDOMContent(container)
      .addTo(map);
  }, [selectedStation, showStations, showUserStations, userLocation]);

  const handleZoomIn = () => {
    mapRef.current?.zoomIn();
  };

  const handleZoomOut = () => {
    mapRef.current?.zoomOut();
  };

  const handleResetView = () => {
    mapRef.current?.flyTo({ center: defaultView.center, zoom: defaultView.zoom, speed: 1.2 });
  };

  const handleLocate = () => {
    if (userLocation) {
      mapRef.current?.flyTo({ center: userLocation, zoom: 12.5, speed: 1.2 });
      return;
    }
    if (onRequestLocation) {
      onRequestLocation();
      return;
    }
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => {
      const coords: [number, number] = [position.coords.longitude, position.coords.latitude];
      mapRef.current?.flyTo({ center: coords, zoom: 12.5, speed: 1.2 });
    });
  };

  const handleShareApp = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Cyprus EV Chargers",
          text: "EV charging stations map for Cyprus",
          url
        });
        return;
      }
    } catch {
      // ignore and fall back to clipboard
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied", { description: "Share it to collect more stations." });
    } catch {
      toast.message("Share this link", { description: url });
    }
  };

  const handleOpenSuggest = () => {
    const map = mapRef.current;
    if (map) {
      const c = map.getCenter();
      setSuggestCoords([c.lng, c.lat]);
    } else {
      setSuggestCoords(null);
    }
    setSuggestOpen(true);
    toast.message("Place the pin", { description: "Drag the purple pin (or tap the map) to set the exact location." });
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!suggestOpen) {
      suggestMarkerRef.current?.remove();
      suggestMarkerRef.current = null;
      return;
    }
    const initial: [number, number] = suggestCoords ?? (() => {
      const c = map.getCenter();
      return [c.lng, c.lat];
    })();
    if (!suggestCoords) setSuggestCoords(initial);

    if (!suggestMarkerRef.current) {
      const el = document.createElement("div");
      el.style.width = "14px";
      el.style.height = "14px";
      el.style.borderRadius = "999px";
      el.style.background = "#a855f7";
      el.style.border = "2px solid #f8fafc";
      el.style.boxShadow = "0 8px 20px rgba(0,0,0,.25)";
      el.style.cursor = "grab";
      suggestMarkerRef.current = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(initial).addTo(map);
    } else {
      suggestMarkerRef.current.setLngLat(initial);
    }

    const marker = suggestMarkerRef.current;
    const onDragEnd = () => {
      const p = marker.getLngLat();
      setSuggestCoords([p.lng, p.lat]);
    };
    marker.on("dragend", onDragEnd);

    const onClick = (e: maplibregl.MapMouseEvent & maplibregl.EventData) => {
      const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      setSuggestCoords(coords);
      marker.setLngLat(coords);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      marker.off("dragend", onDragEnd);
    };
  }, [suggestOpen, suggestCoords]);

  useEffect(() => {
    const marker = suggestMarkerRef.current;
    if (!suggestOpen || !marker || !suggestCoords) return;
    marker.setLngLat(suggestCoords);
  }, [suggestCoords, suggestOpen]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainerRef} className="absolute inset-0" />

      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setSearchOpen((prev) => !prev)}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label={searchOpen ? "Close search" : "Find a charging station"}
            >
              {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">{searchOpen ? "Close search" : "Find a charger"}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setShowStations((prev) => !prev)}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label={showStations ? "Hide stations" : "Show stations"}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">{showStations ? "Hide stations" : "Show stations"}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setShowUserStations((prev) => !prev)}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label={showUserStations ? "Hide user-submitted stations" : "Show user-submitted stations"}
            >
              <Users className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">{showUserStations ? "Hide user stations" : "Show user stations"}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSuggest}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label="Suggest a new charging station"
            >
              <MapPinPlus className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">Suggest a station</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleShareApp}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label="Share this app"
            >
              <Share2 className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">Share app</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleLocate}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label="Center on my location"
            >
              <Crosshair className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">My location</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleResetView}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label="Reset map view"
            >
              <Home className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">Reset view</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleZoomIn}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">Zoom in</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleZoomOut}
              className="rounded-full border bg-background/90 p-2 shadow-soft backdrop-blur transition hover:bg-background"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            <span className="text-xs">Zoom out</span>
          </TooltipContent>
        </Tooltip>
      </div>

      {searchOpen ? (
        <div className="absolute top-4 right-16 z-20 w-[320px] max-w-[calc(100%-5rem)] rounded-xl border bg-background/95 p-3 shadow-soft backdrop-blur">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-sm font-medium">Find a charger</p>
            <button
              type="button"
              className="rounded-md p-1 hover:bg-muted"
              aria-label="Close search"
              onClick={() => setSearchOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder='Search "Nicosia", "CCS", "50kW"...'
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchOpen(false);
              if (e.key === "Enter") {
                const first = smartSearchResults[0]?.station;
                if (first) {
                  onStationSelect?.(first);
                  setSearchOpen(false);
                }
              }
            }}
          />
          <div className="mt-2 max-h-[260px] overflow-y-auto">
            {searchQuery.trim() && smartSearchResults.length === 0 ? (
              <div className="px-1 py-2 text-xs text-muted-foreground">No matches. Try city, connector, or kW.</div>
            ) : null}
            <div className="flex flex-col gap-1">
              {smartSearchResults.map(({ station, distanceKm }) => (
                <button
                  key={station.id}
                  type="button"
                  className="w-full text-left rounded-md px-2 py-2 hover:bg-muted transition"
                  onClick={() => {
                    onStationSelect?.(station);
                    setSearchOpen(false);
                  }}
                >
                  <div className="text-sm font-medium truncate">{station.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {(station.city || station.address || "Cyprus") +
                      (station.power ? ` · ${station.power}` : "") +
                      (distanceKm !== null ? ` · ${distanceKm.toFixed(1)} km` : "")}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* Map Legend */}
      <div className="absolute bottom-4 left-4 bg-background/95 backdrop-blur-sm rounded-lg border shadow-soft p-3 z-10">
        <p className="text-xs font-medium mb-2">Station Status</p>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[hsl(142,76%,36%)]" />
            <span className="text-xs text-muted-foreground">Available</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[hsl(38,92%,50%)]" />
            <span className="text-xs text-muted-foreground">Occupied</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-[hsl(0,84%,60%)]" />
            <span className="text-xs text-muted-foreground">Out of Service</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-muted-foreground" />
            <span className="text-xs text-muted-foreground">Unknown</span>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <div className="w-3 h-3 rounded-full bg-[#a855f7]" />
            <span className="text-xs text-muted-foreground">User suggested</span>
          </div>
        </div>
      </div>

      <SuggestStationDialog
        open={suggestOpen}
        onOpenChange={(open) => {
          setSuggestOpen(open);
          if (!open) {
            suggestMarkerRef.current?.remove();
            suggestMarkerRef.current = null;
          }
        }}
        coordinates={suggestCoords}
      />
    </div>
  );
}
