import { useState, useEffect, useMemo } from 'react';
import Header from '@/components/Header';
import HeroSection from '@/components/HeroSection';
import StatsSection from '@/components/StatsSection';
import ChargingStationMap from '@/components/ChargingStationMap';
import ChargingStationList from '@/components/ChargingStationList';
import RoutePlanner from '@/components/RoutePlanner';
import { fetchChargingStations, sampleChargingStations, ChargingStation } from '@/lib/chargingStations';
import { fetchOpenChargeMapDetailsByCoords, parseOpenChargeMapUsageCost } from '@/lib/openChargeMap';
import { VEHICLE_PROFILES, type VehicleProfile, stationFitsVehicle, stationMeetsMinPower } from '@/lib/vehicleProfiles';
import { getWatchState, runAlertChecks, setAlertsEnabled } from '@/lib/alerts';
import {
  approveSuggestion,
  importSuggestionFromUrlParam,
  listApprovedSuggestions,
  listPendingSuggestions,
  removeApprovedSuggestion,
  rejectSuggestion,
  suggestionToChargingStation,
  type StationSuggestion
} from '@/lib/userSuggestions';
import { buildGlobalUserStationsFile, fetchGlobalApprovedSuggestions } from '@/lib/globalUserStations';
import { toast } from '@/components/ui/sonner';
import { Helmet } from 'react-helmet-async';
import { BatteryCharging, Heart, MapPin, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const uniqBy = <T,>(items: T[], key: (item: T) => string) => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
};

const downloadTextFile = (filename: string, text: string) => {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const Index = () => {
  const [stations, setStations] = useState<ChargingStation[]>([]);
  const [selectedStation, setSelectedStation] = useState<ChargingStation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied' | 'error'>(
    'idle'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedConnector, setSelectedConnector] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');
  const [openNowOnly, setOpenNowOnly] = useState(false);
  const [fastOnly, setFastOnly] = useState(false);
  const [cheapestRadiusKm, setCheapestRadiusKm] = useState('10');
  const [cheapestMode, setCheapestMode] = useState<'any' | 'ac' | 'dc'>('any');
  const [cheapestPending, setCheapestPending] = useState(false);
  const [cheapestResult, setCheapestResult] = useState<{
    station: ChargingStation;
    rate: number;
    mode: 'any' | 'ac' | 'dc';
  } | null>(null);
  const [routeOverlay, setRouteOverlay] = useState<{
    templateId: string;
    polyline: [number, number][];
    stopIds: string[];
  } | null>(null);
  const [routePlannerOpen, setRoutePlannerOpen] = useState(false);

  const [vehicleProfileId, setVehicleProfileId] = useState<string>('any');
  const [onlyCompatible, setOnlyCompatible] = useState(false);
  const [minPowerKw, setMinPowerKw] = useState('0');

  const [alertsEnabled, setAlertsEnabledState] = useState(false);
  const [watchedCount, setWatchedCount] = useState(0);
  const [pendingSuggestions, setPendingSuggestions] = useState<StationSuggestion[]>([]);
  const [approvedSuggestions, setApprovedSuggestions] = useState<StationSuggestion[]>([]);
  const [globalApprovedSuggestions, setGlobalApprovedSuggestions] = useState<StationSuggestion[]>([]);

  const isAdmin = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('admin') === '1';
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const loadStations = async () => {
      try {
        const data = await fetchChargingStations();
        const base = data.length > 0 ? data : sampleChargingStations;
        const globalApproved = await fetchGlobalApprovedSuggestions();
        setGlobalApprovedSuggestions(globalApproved);

        const globalStations = globalApproved.map(suggestionToChargingStation);
        const localApprovedStations = listApprovedSuggestions().map(suggestionToChargingStation);
        setStations(uniqBy([...base, ...globalStations, ...localApprovedStations], (s) => s.id));
      } catch (error) {
        console.error('Failed to load charging stations:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadStations();
  }, []);

  useEffect(() => {
    const refresh = () => {
      setPendingSuggestions(listPendingSuggestions());
      setApprovedSuggestions(listApprovedSuggestions());
    };
    refresh();
    const onStorage = () => refresh();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    // Admin can import a user submission via a link: ?importSuggestion=...
    try {
      const url = new URL(window.location.href);
      const payload = url.searchParams.get('importSuggestion');
      if (!payload) return;
      const autoApprove = url.searchParams.get('autoApprove') === '1';
      const imported = importSuggestionFromUrlParam(payload);
      if (imported) {
        if (isAdmin && autoApprove) {
          const approved = approveSuggestion(imported.id);
          if (approved) {
            setStations((prev) => {
              const id = `user/${approved.id}`;
              if (prev.some((x) => x.id === id)) return prev;
              return [...prev, suggestionToChargingStation(approved)];
            });
            setPendingSuggestions(listPendingSuggestions());
            setApprovedSuggestions(listApprovedSuggestions());
            toast.success('Approved & added to map', {
              description: 'Shown as “User suggested (unverified)”. To publish for everyone, update public/user-stations.json.'
            });
          } else {
            toast.success('Suggestion imported', { description: 'It is now pending admin approval.' });
          }
        } else {
          toast.success('Suggestion imported', { description: 'It is now pending admin approval.' });
        }
      } else {
        toast.error('Invalid suggestion link');
      }
      url.searchParams.delete('importSuggestion');
      url.searchParams.delete('autoApprove');
      window.history.replaceState({}, '', url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : ''));
    } catch {
      // ignore
    }
  }, [isAdmin]);

  useEffect(() => {
    const refresh = () => {
      const state = getWatchState();
      setAlertsEnabledState(state.enabled);
      setWatchedCount(state.rules.length);
    };
    refresh();
    const onStorage = () => refresh();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!alertsEnabled || watchedCount === 0) return;
    const intervalMs = 3 * 60 * 1000;
    const id = window.setInterval(async () => {
      try {
        const data = await fetchChargingStations();
        if (data.length) {
          runAlertChecks(data);
          setStations(data);
        }
      } catch {
        // ignore polling errors
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [alertsEnabled, watchedCount]);

  const vehicleProfile: VehicleProfile | null = useMemo(() => {
    return VEHICLE_PROFILES.find((p) => p.id === vehicleProfileId) ?? VEHICLE_PROFILES[0] ?? null;
  }, [vehicleProfileId]);

  useEffect(() => {
    const loadOcm = async () => {
      if (!selectedStation) return;
      if (selectedStation.ocm) return;
      try {
        const [lon, lat] = selectedStation.coordinates;
        const details = await fetchOpenChargeMapDetailsByCoords(lat, lon);
        if (!details) return;
        setStations((prev) =>
          prev.map((station) =>
            station.id === selectedStation.id ? { ...station, ocm: details } : station
          )
        );
        setSelectedStation((prev) => (prev?.id === selectedStation.id ? { ...prev, ocm: details } : prev));
      } catch (error) {
        console.warn('Failed to load OpenChargeMap details:', error);
      }
    };

    loadOcm();
  }, [selectedStation]);

  const connectorOptions = useMemo(() => {
    const connectors = new Set<string>();
    stations.forEach((station) => {
      station.connectors?.forEach((connector) => connectors.add(connector));
    });
    return Array.from(connectors).sort();
  }, [stations]);

  const parsePowerKw = (power?: string) => {
    if (!power) return null;
    const match = power.match(/([\d.]+)/);
    if (!match) return null;
    return Number(match[1]);
  };

  const haversineDistanceKm = (from: [number, number], to: [number, number]) => {
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

  const stationsWithDistance = useMemo(() => {
    if (!userLocation) return stations;
    return stations.map((station) => {
      const distanceKm = haversineDistanceKm(userLocation, station.coordinates);
      const distanceLabel =
        distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`;
      return { ...station, distanceKm, distanceLabel };
    });
  }, [stations, userLocation]);

  const filteredStations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const results = stationsWithDistance.filter((station) => {
      const matchesQuery =
        !query ||
        station.name.toLowerCase().includes(query) ||
        station.city?.toLowerCase().includes(query) ||
        station.address?.toLowerCase().includes(query);
      const matchesConnector =
        selectedConnector === 'all' ||
        station.connectors?.some((connector) => connector === selectedConnector);
      const matchesAvailability =
        availabilityFilter === 'all' ||
        (availabilityFilter === 'unknown'
          ? !station.availability || station.availability === 'unknown'
          : station.availability === availabilityFilter);
      const matchesOpenNow = !openNowOnly || station.open24_7;
      const powerKw = parsePowerKw(station.power);
      const matchesFast = !fastOnly || (powerKw !== null && powerKw >= 50);
      const minKw = Number(minPowerKw);
      const matchesMinPower = !minKw || stationMeetsMinPower(station, minKw);
      const matchesVehicle = !onlyCompatible || !vehicleProfile ? true : stationFitsVehicle(station, vehicleProfile);

      return (
        matchesQuery &&
        matchesConnector &&
        matchesAvailability &&
        matchesOpenNow &&
        matchesFast &&
        matchesMinPower &&
        matchesVehicle
      );
    });

    if (userLocation) {
      return results.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    }
    return results;
  }, [
    stationsWithDistance,
    searchQuery,
    selectedConnector,
    availabilityFilter,
    openNowOnly,
    fastOnly,
    onlyCompatible,
    minPowerKw,
    vehicleProfile,
    userLocation
  ]);

  const nearestStation = useMemo(() => {
    if (!userLocation || filteredStations.length === 0) return null;
    return filteredStations.reduce((closest, station) => {
      if (!station.distanceKm) return closest;
      if (!closest?.distanceKm) return station;
      return station.distanceKm < closest.distanceKm ? station : closest;
    }, filteredStations[0]);
  }, [filteredStations, userLocation]);

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('error');
      return;
    }
    setLocationStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation([position.coords.longitude, position.coords.latitude]);
        setLocationStatus('idle');
      },
      (error) => {
        setLocationStatus(error.code === error.PERMISSION_DENIED ? 'denied' : 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const findCheapestNearby = () => {
    if (locationStatus === 'loading') return;
    if (!userLocation) {
      setCheapestPending(true);
      requestLocation();
      return;
    }

    const radius = Number(cheapestRadiusKm);
    const radiusKm = Number.isFinite(radius) && radius > 0 ? radius : 10;

    const candidates = filteredStations.filter((station) => {
      const distanceKm =
        typeof station.distanceKm === 'number'
          ? station.distanceKm
          : haversineDistanceKm(userLocation, station.coordinates);
      return distanceKm <= radiusKm;
    });

    const pickRate = (station: ChargingStation): number | null => {
      const rates = parseOpenChargeMapUsageCost(station.ocm?.usageCost);
      if (rates.isFree) return 0;
      if (cheapestMode === 'ac' && typeof rates.ac === 'number') return rates.ac;
      if (cheapestMode === 'dc' && typeof rates.dc === 'number') return rates.dc;
      if (typeof rates.min === 'number') return rates.min;
      return null;
    };

    let best: { station: ChargingStation; rate: number } | null = null;
    for (const station of candidates) {
      const rate = pickRate(station);
      if (rate === null) continue;
      if (!best || rate < best.rate) best = { station, rate };
    }

    if (!best) {
      setCheapestResult(null);
      return;
    }

    setCheapestResult({ station: best.station, rate: best.rate, mode: cheapestMode });
    setSelectedStation(best.station);
  };

  useEffect(() => {
    if (!cheapestPending) return;
    if (!userLocation) return;
    setCheapestPending(false);
    findCheapestNearby();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cheapestPending, userLocation]);

  useEffect(() => {
    // First-open UX: default to Map section and keep Route Planner collapsed.
    const onHash = () => {
      try {
        if (window.location.hash === '#route') setRoutePlannerOpen(true);
      } catch {
        // ignore
      }
    };

    try {
      if (!window.location.hash) {
        window.location.hash = '#map';
        window.setTimeout(() => {
          document.querySelector('#map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 0);
      } else {
        onHash();
      }
    } catch {
      // ignore
    }

    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      <Helmet>
        <title>ChargeCyprus - Find EV Charging Stations</title>
        <meta
          name="description"
          content="Discover electric vehicle charging stations across Cyprus. Find fast chargers, connector types, and plan your next EV trip."
        />
        <meta
          name="keywords"
          content="Cyprus, EV charging, electric vehicles, fast chargers, charging stations, map"
        />
        <link rel="canonical" href="https://chargecyprus.app" />
      </Helmet>

      <div className="min-h-screen bg-background">
        <Header />

        <main>
          <HeroSection />

          <StatsSection />

          {/* Route Planner Section (collapsed by default) */}
          <section id="route" className="py-10 px-4 bg-muted/30">
            <div className="container">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border bg-background p-4 shadow-soft">
                <div>
                  <p className="text-xs text-muted-foreground">Route planner</p>
                  <p className="font-display font-semibold">Route-aware charging (Κύπρος)</p>
                  <p className="text-sm text-muted-foreground max-w-2xl">
                    Ο EV driver δεν ψάχνει “έναν φορτιστή”—ψάχνει να φτάσει κάπου. Δες αν φτάνεις με το SOC σου, πού να
                    φορτίσεις και για πόση ώρα.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    variant={routePlannerOpen ? 'outline' : 'secondary'}
                    onClick={() => setRoutePlannerOpen((v) => !v)}
                  >
                    {routePlannerOpen ? 'Hide' : 'Show'}
                  </Button>
                  {!routePlannerOpen ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        window.location.hash = '#map';
                        document.querySelector('#map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
                      Go to map
                    </Button>
                  ) : null}
                </div>
              </div>

              {routePlannerOpen ? (
                <div className="max-w-5xl mx-auto mt-6">
                  <RoutePlanner
                    stations={stations}
                    onSelectStation={(station) => setSelectedStation(station)}
                    onApplyToMap={({ templateId, polyline, suggestedStopStationIds }) => {
                      setRouteOverlay({ templateId, polyline, stopIds: suggestedStopStationIds });
                    }}
                  />
                </div>
              ) : null}
            </div>
          </section>

          {/* Map Section */}
          <section id="map" className="py-16 px-4">
            <div className="container">
              <div className="text-center mb-12">
                <h2 className="font-display text-3xl sm:text-4xl font-bold mb-4">
                  Interactive Charging Map
                </h2>
                <p className="text-muted-foreground max-w-lg mx-auto">
                  Explore EV charging locations across Cyprus and select a station to see details.
                </p>
              </div>

              <div className="mb-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 rounded-xl border bg-background p-4 shadow-soft">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Find stations near you</p>
                  <p className="text-xs text-muted-foreground">
                    Share your location to highlight the closest available chargers.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={requestLocation}
                    variant="default"
                    className="gap-2"
                    disabled={locationStatus === 'loading'}
                  >
                    <Navigation className="w-4 h-4" />
                    {locationStatus === 'loading' ? 'Locating...' : 'Use my location'}
                  </Button>
                  {userLocation && (
                    <Button variant="outline" onClick={() => setUserLocation(null)}>
                      Clear location
                    </Button>
                  )}
                </div>
              </div>

              <div className="mb-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 rounded-xl border bg-background p-4 shadow-soft">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Find the cheapest nearby</p>
                  <p className="text-xs text-muted-foreground">
                    Uses your current filters and OpenChargeMap cost data.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                  <Select value={cheapestRadiusKm} onValueChange={setCheapestRadiusKm}>
                    <SelectTrigger className="w-full sm:w-[140px]">
                      <SelectValue placeholder="Radius" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">Within 5 km</SelectItem>
                      <SelectItem value="10">Within 10 km</SelectItem>
                      <SelectItem value="25">Within 25 km</SelectItem>
                      <SelectItem value="50">Within 50 km</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={cheapestMode}
                    onValueChange={(value) => {
                      const next = value === 'any' || value === 'ac' || value === 'dc' ? value : 'any';
                      setCheapestMode(next);
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-[140px]">
                      <SelectValue placeholder="AC/DC" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="ac">AC</SelectItem>
                      <SelectItem value="dc">DC</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={findCheapestNearby}
                    disabled={locationStatus === 'loading'}
                  >
                    Find cheapest
                  </Button>
                </div>
              </div>

              {cheapestResult && (
                <div className="mb-6 rounded-xl border bg-muted/30 p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">Cheapest match</p>
                      <p className="font-display font-semibold">{cheapestResult.station.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {cheapestResult.station.distanceLabel
                          ? `${cheapestResult.station.distanceLabel} away · `
                          : ''}
                        {cheapestResult.mode.toUpperCase()} · {cheapestResult.rate.toFixed(2)}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      className="gap-2"
                      onClick={() => setSelectedStation(cheapestResult.station)}
                    >
                      <MapPin className="w-4 h-4" />
                      View on map
                    </Button>
                  </div>
                </div>
              )}

              {locationStatus === 'denied' && (
                <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
                  Location access was denied. You can still browse stations manually or enable
                  location permissions in your browser settings.
                </div>
              )}

              {nearestStation && (
                <div className="mb-6 rounded-xl border bg-muted/30 p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">Nearest station</p>
                      <p className="font-display font-semibold">{nearestStation.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {nearestStation.distanceLabel} away · {nearestStation.city || 'Cyprus'}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      className="gap-2"
                      onClick={() => setSelectedStation(nearestStation)}
                    >
                      <MapPin className="w-4 h-4" />
                      View on map
                    </Button>
                  </div>
                </div>
              )}

              {isAdmin ? (
                <div className="mb-6 rounded-xl border bg-background p-4 shadow-soft">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Admin</p>
                      <p className="font-medium">User-submitted station suggestions</p>
                      <p className="text-xs text-muted-foreground">
                        Pending: {pendingSuggestions.length} · Approved: {approvedSuggestions.length}
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Tip: open submission links with <code>?admin=1</code> to review & approve.
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl border bg-muted/20 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-xs text-muted-foreground">Global publish (Option A)</p>
                        <p className="text-sm font-medium">Update the shared stations file for everyone</p>
                        <p className="text-xs text-muted-foreground">
                          Published: {globalApprovedSuggestions.length} · Local approved (not yet published): {approvedSuggestions.length}
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={async () => {
                            const merged = uniqBy(
                              [...globalApprovedSuggestions, ...approvedSuggestions],
                              (s) => String(s.id ?? '')
                            );
                            const file = buildGlobalUserStationsFile(merged);
                            const text = JSON.stringify(file, null, 2) + '\n';
                            try {
                              await navigator.clipboard.writeText(text);
                              toast.success('Copied user-stations.json', {
                                description: 'Paste into public/user-stations.json on main and merge.'
                              });
                            } catch {
                              downloadTextFile('user-stations.json', text);
                              toast.message('Downloaded user-stations.json', {
                                description: 'Commit it to public/user-stations.json and deploy.'
                              });
                            }
                          }}
                        >
                          Copy JSON
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const merged = uniqBy(
                              [...globalApprovedSuggestions, ...approvedSuggestions],
                              (s) => String(s.id ?? '')
                            );
                            const file = buildGlobalUserStationsFile(merged);
                            const text = JSON.stringify(file, null, 2) + '\n';
                            downloadTextFile('user-stations.json', text);
                            toast.message('Downloaded', { description: 'Commit to public/user-stations.json and redeploy.' });
                          }}
                        >
                          Download JSON
                        </Button>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      After approving/editing/removing, update <code>public/user-stations.json</code> in the repo and deploy
                      (push to <code>main</code>).
                    </p>
                  </div>

                  {pendingSuggestions.length ? (
                    <div className="mt-3 space-y-2">
                      {pendingSuggestions.slice(0, 12).map((s) => (
                        <div
                          key={s.id}
                          className="rounded-lg border bg-muted/20 p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div className="font-medium truncate">{s.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {(s.city || s.address || 'Cyprus') +
                                (s.powerKw ? ` · ${s.powerKw} kW` : '') +
                                (s.connectors?.length ? ` · ${s.connectors.join(', ')}` : '')}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                const approved = approveSuggestion(s.id);
                                if (approved) {
                                  setStations((prev) => {
                                    const id = `user/${approved.id}`;
                                    if (prev.some((x) => x.id === id)) return prev;
                                    return [...prev, suggestionToChargingStation(approved)];
                                  });
                                  setPendingSuggestions(listPendingSuggestions());
                                  setApprovedSuggestions(listApprovedSuggestions());
                                  toast.success('Approved', { description: 'Now shown on the map as “User suggested”.' });
                                }
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                rejectSuggestion(s.id);
                                setPendingSuggestions(listPendingSuggestions());
                                toast.message('Rejected', { description: 'Removed from pending list.' });
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        </div>
                      ))}
                      {pendingSuggestions.length > 12 ? (
                        <div className="text-xs text-muted-foreground">Showing first 12 pending suggestions.</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-muted-foreground">No pending suggestions.</div>
                  )}

                  {approvedSuggestions.length ? (
                    <div className="mt-4">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Approved (local)</p>
                      <div className="grid gap-2 md:grid-cols-2">
                        {approvedSuggestions.slice(0, 6).map((s) => (
                          <div key={s.id} className="rounded-lg border bg-muted/10 p-3 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{s.name}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                {(s.city || 'Cyprus') + (s.powerKw ? ` · ${s.powerKw} kW` : '')}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                removeApprovedSuggestion(s.id);
                                setApprovedSuggestions(listApprovedSuggestions());
                                setStations((prev) => prev.filter((st) => st.id !== `user/${s.id}`));
                                toast.message('Removed', {
                                  description: 'Removed from your local map. To remove for everyone, update public/user-stations.json.'
                                });
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="h-[500px] lg:h-[600px]">
                <ChargingStationMap
                  stations={filteredStations}
                  selectedStation={selectedStation}
                  onStationSelect={setSelectedStation}
                  onRequestLocation={requestLocation}
                  userLocation={userLocation}
                  routePolyline={routeOverlay?.polyline ?? null}
                  highlightStationIds={routeOverlay?.stopIds ?? []}
                />
              </div>
            </div>
          </section>

          {/* Stations Section */}
          <section id="stations" className="py-16 px-4 bg-muted/30">
            <div className="container">
              <div className="text-center mb-12">
                <h2 className="font-display text-3xl sm:text-4xl font-bold mb-4">
                  All Charging Stations
                </h2>
                <p className="text-muted-foreground max-w-lg mx-auto">
                  {isLoading
                    ? 'Loading stations...'
                    : `${filteredStations.length} charging stations available across Cyprus`}
                </p>
              </div>

              <div className="mb-8 grid gap-4 rounded-xl border bg-background p-4 shadow-soft md:grid-cols-2 lg:grid-cols-4">
                <Input
                  placeholder="Search by city or station name"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <Select value={vehicleProfileId} onValueChange={setVehicleProfileId}>
                  <SelectTrigger>
                    <SelectValue placeholder="My EV" />
                  </SelectTrigger>
                  <SelectContent>
                    {VEHICLE_PROFILES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={selectedConnector} onValueChange={setSelectedConnector}>
                  <SelectTrigger>
                    <SelectValue placeholder="Connector type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All connectors</SelectItem>
                    {connectorOptions.map((connector) => (
                      <SelectItem key={connector} value={connector}>
                        {connector}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={availabilityFilter} onValueChange={setAvailabilityFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Availability" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="available">Available</SelectItem>
                    <SelectItem value="occupied">Occupied</SelectItem>
                    <SelectItem value="out_of_service">Out of service</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={minPowerKw} onValueChange={setMinPowerKw}>
                  <SelectTrigger>
                    <SelectValue placeholder="Min power" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Any power</SelectItem>
                    <SelectItem value="7">7 kW+</SelectItem>
                    <SelectItem value="11">11 kW+</SelectItem>
                    <SelectItem value="22">22 kW+</SelectItem>
                    <SelectItem value="50">50 kW+ (DC)</SelectItem>
                    <SelectItem value="100">100 kW+</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between gap-3 rounded-md border border-input px-3 py-2">
                  <span className="text-sm">Open 24/7 only</span>
                  <Switch checked={openNowOnly} onCheckedChange={setOpenNowOnly} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border border-input px-3 py-2">
                  <span className="text-sm">Fast chargers (50kW+)</span>
                  <Switch checked={fastOnly} onCheckedChange={setFastOnly} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border border-input px-3 py-2">
                  <span className="text-sm">Fits my EV only</span>
                  <Switch checked={onlyCompatible} onCheckedChange={setOnlyCompatible} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border border-input px-3 py-2">
                  <span className="text-sm">
                    Alerts {watchedCount ? `(${watchedCount})` : ''}
                  </span>
                  <Switch
                    checked={alertsEnabled}
                    onCheckedChange={(next) => {
                      setAlertsEnabled(next);
                      setAlertsEnabledState(next);
                    }}
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchQuery('');
                    setVehicleProfileId('any');
                    setSelectedConnector('all');
                    setAvailabilityFilter('all');
                    setMinPowerKw('0');
                    setOpenNowOnly(false);
                    setFastOnly(false);
                    setOnlyCompatible(false);
                  }}
                >
                  Reset filters
                </Button>
              </div>

              <div className="max-w-2xl mx-auto">
                <ChargingStationList
                  stations={filteredStations}
                  selectedStation={selectedStation}
                  onSelect={setSelectedStation}
                  userLocation={userLocation}
                  vehicleProfile={vehicleProfileId === 'any' ? null : vehicleProfile}
                />
              </div>
            </div>
          </section>

          {/* About Section */}
          <section id="about" className="py-16 px-4">
            <div className="container">
              <div className="max-w-3xl mx-auto text-center">
                <h2 className="font-display text-3xl sm:text-4xl font-bold mb-6">
                  About ChargeCyprus
                </h2>
                <p className="text-muted-foreground mb-6">
                  ChargeCyprus highlights EV charging infrastructure across the island using
                  curated station data and live map context. Our goal is to make sustainable travel
                  easier by spotlighting connector types, fast chargers, and 24/7 locations.
                </p>
                <div className="inline-flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>Data source:</span>
                  <a
                    href="https://github.com/kotsiosla/cyprusevstations"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Cyprus EV Stations
                  </a>
                  <span className="text-muted-foreground/60">·</span>
                  <a
                    href="https://www.esri.com/en-us/arcgis/products/arcgis-online/features/world-imagery"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Esri World Imagery
                  </a>
                </div>
              </div>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="py-8 px-4 border-t">
          <div className="container">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-primary text-primary-foreground">
                  <BatteryCharging className="w-4 h-4" />
                </div>
                <span className="font-display font-semibold">ChargeCyprus</span>
              </div>
              <p className="text-sm text-muted-foreground flex items-center gap-1">
                Made with <Heart className="w-4 h-4 text-destructive" /> for EV drivers in Cyprus
              </p>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
};

export default Index;
