"use client";

import { useEffect, useState } from "react";

type RouteSnapshot = {
  snapshot_version?: number;
  created_at_ms?: number;
  route_source?: string;
  weather_avg_temp_c?: number;
  weather_avg_rain_mmh?: number;
  weather_avg_wind_kmh?: number;
  weather_avg_headwind_ms?: number;
  elevation_gain_m?: number;
  elevation_loss_m?: number;
  max_grade_pct?: number;
  weather_impact_eco_kwh?: number;
  weather_impact_eco_eur?: number;
  battery_end_pct_requested?: number;
  battery_end_pct_effective?: number;
  total_eco_time_min?: number;
  total_eco_drive_time_min?: number;
  total_eco_charge_time_min?: number;
  total_eco_preconditioning_time_min?: number;
  max_time_penalty_pct?: number;
  charging_soc_soft_cap_pct?: number;
  total_eco_trip_cost_all_in_eur?: number;
  total_limit_trip_cost_all_in_eur?: number;
  warnings?: string[];
  routeChargingStations?: Array<{
    segmentIndex?: number;
    batteryLevelAtCharge?: number;
    batteryPctAfterCharge?: number;
    chargingTimeMinutes?: number;
    chargingTimeIsMinimum?: boolean;
    energyToCharge?: number;
    estimatedChargeCostEur?: number;
    distKmFromRoute?: number;
    station?: {
      name?: string;
      powerKw?: number;
      operator?: string;
      address?: string;
      price?: string;
    };
  }>;
};

type StoredTrip = {
  id?: string;
  createdAt?: number;
  distanceKm?: number;
  ecoEnergyKwh?: number;
  energySavedKwh?: number;
  actualEnergyKwh?: number | null;
  costSavedEur?: number;
  chargingStopsCount?: number;
  plannedDistanceKmBase?: number;
  plannedEnergySavedKwhBase?: number;
  plannedCostSavedEurBase?: number;
};

const TRIPS_KEY = "ecospeed_trips_v1";
const LAST_ROUTE_KEY = "ecospeed_last_route_v1";
const ROUTE_SNAPSHOT_VERSION = 3;
const MIN_REALISTIC_CHARGE_STOP_MIN = 8;
const TEXT_LEAF_SELECTORS = "div,span,p,small,strong,h1,h2,h3,h4,h5,h6";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readTrips(): StoredTrip[] {
  return parseJson<StoredTrip[]>(window.localStorage.getItem(TRIPS_KEY)) ?? [];
}

function writeTrips(trips: StoredTrip[]) {
  window.localStorage.setItem(TRIPS_KEY, JSON.stringify(trips));
}

function readLastRoute(): RouteSnapshot | null {
  const route = parseJson<RouteSnapshot>(window.localStorage.getItem(LAST_ROUTE_KEY));
  if (!route) return null;
  if (route.snapshot_version !== ROUTE_SNAPSHOT_VERSION) return null;
  if (!Number.isFinite(Number(route.created_at_ms ?? Number.NaN))) return null;
  if (Date.now() - Number(route.created_at_ms) > 30 * 60 * 1000) return null;
  return route;
}

function buildRouteSnapshot(data: unknown): RouteSnapshot {
  const route = data as Record<string, unknown> | null;
  const planning = (route?.planning_assumptions ?? {}) as Record<string, unknown>;
  return {
    snapshot_version: ROUTE_SNAPSHOT_VERSION,
    created_at_ms: Date.now(),
    route_source: String(route?.route_source ?? planning.route_source ?? ""),
    weather_avg_temp_c: Number(route?.weather_avg_temp_c ?? Number.NaN),
    weather_avg_rain_mmh: Number(route?.weather_avg_rain_mmh ?? Number.NaN),
    weather_avg_wind_kmh: Number(route?.weather_avg_wind_kmh ?? Number.NaN),
    weather_avg_headwind_ms: Number(route?.weather_avg_headwind_ms ?? Number.NaN),
    elevation_gain_m: Number(route?.elevation_gain_m ?? Number.NaN),
    elevation_loss_m: Number(route?.elevation_loss_m ?? Number.NaN),
    max_grade_pct: Number(route?.max_grade_pct ?? Number.NaN),
    weather_impact_eco_kwh: Number(route?.weather_impact_eco_kwh ?? Number.NaN),
    weather_impact_eco_eur: Number(route?.weather_impact_eco_eur ?? Number.NaN),
    battery_end_pct_requested: Number(route?.battery_end_pct_requested ?? Number.NaN),
    battery_end_pct_effective: Number(route?.battery_end_pct_effective ?? Number.NaN),
    total_eco_time_min: Number(route?.total_eco_time_min ?? Number.NaN),
    total_eco_drive_time_min: Number(route?.total_eco_drive_time_min ?? Number.NaN),
    total_eco_charge_time_min: Number(route?.total_eco_charge_time_min ?? Number.NaN),
    total_eco_preconditioning_time_min: Number(route?.total_eco_preconditioning_time_min ?? Number.NaN),
    max_time_penalty_pct: Number(planning.max_time_penalty_pct ?? Number.NaN),
    charging_soc_soft_cap_pct: Number(planning.charging_soc_soft_cap_pct ?? Number.NaN),
    total_eco_trip_cost_all_in_eur: Number(route?.total_eco_trip_cost_all_in_eur ?? Number.NaN),
    total_limit_trip_cost_all_in_eur: Number(route?.total_limit_trip_cost_all_in_eur ?? Number.NaN),
    warnings: Array.isArray(route?.warnings) ? route?.warnings.filter((x): x is string => typeof x === "string") : [],
    routeChargingStations: Array.isArray(route?.routeChargingStations) ? (route.routeChargingStations as RouteSnapshot["routeChargingStations"]) : [],
  };
}

function persistRouteSnapshot(snap: RouteSnapshot) {
  window.localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(snap));
}

function attachLatestRouteSavings(trips: StoredTrip[], route: RouteSnapshot | null) {
  if (!route || trips.length === 0) return false;
  const latest = trips[0];
  if (!latest) return false;
  let changed = false;
  const limit = Number(route.total_limit_trip_cost_all_in_eur ?? Number.NaN);
  const eco = Number(route.total_eco_trip_cost_all_in_eur ?? Number.NaN);
  if (Number.isFinite(limit) && Number.isFinite(eco)) {
    const nextSaved = Math.max(0, limit - eco);
    if (latest.plannedCostSavedEurBase === undefined || Math.abs(Number(latest.plannedCostSavedEurBase) - nextSaved) > 1e-6) {
      latest.plannedCostSavedEurBase = nextSaved;
      changed = true;
    }
  }
  const nextStopsCount = Array.isArray(route.routeChargingStations) ? route.routeChargingStations.length : 0;
  if (Number(latest.chargingStopsCount ?? Number.NaN) !== nextStopsCount) {
    latest.chargingStopsCount = nextStopsCount;
    changed = true;
  }
  return changed;
}

function normalizeTripsWithRealProgress(trips: StoredTrip[]): boolean {
  let changed = false;
  for (const t of trips) {
    const plannedDist =
      Number.isFinite(Number(t.plannedDistanceKmBase)) && Number(t.plannedDistanceKmBase) >= 0
        ? Number(t.plannedDistanceKmBase)
        : Math.max(0, Number(t.distanceKm ?? 0));
    const plannedSaved =
      Number.isFinite(Number(t.plannedEnergySavedKwhBase)) && Number(t.plannedEnergySavedKwhBase) >= 0
        ? Number(t.plannedEnergySavedKwhBase)
        : Math.max(0, Number(t.energySavedKwh ?? 0));
    const plannedCostSaved =
      Number.isFinite(Number(t.plannedCostSavedEurBase)) && Number(t.plannedCostSavedEurBase) >= 0
        ? Number(t.plannedCostSavedEurBase)
        : plannedSaved * 0.25;

    if (t.plannedDistanceKmBase === undefined) {
      t.plannedDistanceKmBase = plannedDist;
      changed = true;
    }
    if (t.plannedEnergySavedKwhBase === undefined) {
      t.plannedEnergySavedKwhBase = plannedSaved;
      changed = true;
    }
    if (t.plannedCostSavedEurBase === undefined) {
      t.plannedCostSavedEurBase = plannedCostSaved;
      changed = true;
    }

    const ecoEnergy = Math.max(0.001, Number(t.ecoEnergyKwh ?? 0.001));
    const actualEnergy = Number(t.actualEnergyKwh ?? Number.NaN);
    const ratio = Number.isFinite(actualEnergy) && actualEnergy > 0 ? clamp(actualEnergy / ecoEnergy, 0, 1) : 0;
    const realDistance = plannedDist * ratio;
    const realSaved = plannedSaved * ratio;
    const realSavedEur = plannedCostSaved * ratio;

    if (Math.abs(Number(t.distanceKm ?? 0) - realDistance) > 1e-6) {
      t.distanceKm = realDistance;
      changed = true;
    }
    if (Math.abs(Number(t.energySavedKwh ?? 0) - realSaved) > 1e-6) {
      t.energySavedKwh = realSaved;
      changed = true;
    }
    if (Math.abs(Number(t.costSavedEur ?? 0) - realSavedEur) > 1e-6) {
      t.costSavedEur = realSavedEur;
      changed = true;
    }
  }
  return changed;
}

function queryLeafTextNodesWithin(root: ParentNode, selectors: string) {
  return Array.from(root.querySelectorAll<HTMLElement>(selectors)).filter((node) => node.children.length === 0);
}

function patchTripsCompletedText(totalSavedEur: number) {
  const nodes = queryLeafTextNodesWithin(document, "p,span,small,strong");
  for (const n of nodes) {
    const txt = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt) continue;
    const isTrips = /trips completed/i.test(txt) || /trajets?\s+termin/i.test(txt);
    if (!isTrips) continue;
    const clean = txt.replace(/\s*\|\s*(Total saved|Total economise).*$/i, "");
    n.textContent = `${clean} | Total economise: ${totalSavedEur.toFixed(2)} EUR`;
    break;
  }
}

function patchGreetingText() {
  const nodes = queryLeafTextNodesWithin(document, TEXT_LEAF_SELECTORS);
  for (const n of nodes) {
    const txt = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt || !/hello\s+ethan/i.test(txt)) continue;
    n.textContent = txt.replace(/hello\s+ethan/gi, "Hello Lucas");
  }
}

function patchChargeDurationLabels() {
  const nodes = queryLeafTextNodesWithin(document, "div,span,p,small,strong");
  for (const n of nodes) {
    const txt = (n.textContent || "").replace(/\s+/g, " ").trim();
    const match = txt.match(/^Temps de charge:\s*(\d+(?:[.,]\d+)?)\s*min$/i);
    if (!match) continue;
    const displayedMin = Number(String(match[1]).replace(",", "."));
    if (!Number.isFinite(displayedMin) || displayedMin >= MIN_REALISTIC_CHARGE_STOP_MIN) continue;
    n.textContent = `Temps de charge: ${MIN_REALISTIC_CHARGE_STOP_MIN} min minimum`;
  }
}

function findRecentTripsHeading() {
  return queryLeafTextNodesWithin(document, TEXT_LEAF_SELECTORS).find((node) => {
    const txt = (node.textContent || "").replace(/\s+/g, " ").trim();
    return txt === "Recent trips" || txt === "Trajets recents";
  }) as HTMLElement | undefined;
}

function patchRecentTripsRechargeCounts(trips: StoredTrip[]) {
  const scope = findRecentTripsHeading()?.parentElement ?? document.body;
  const labelNodes = queryLeafTextNodesWithin(scope, "div,span,p,small,strong").filter((node) => {
    const txt = (node.textContent || "").trim();
    return txt === "Recharges";
  });

  labelNodes.forEach((labelNode, index) => {
    const count = Number(trips[index]?.chargingStopsCount ?? Number.NaN);
    if (!Number.isFinite(count)) return;
    const container = labelNode.parentElement;
    if (!container) return;
    const valueNode = queryLeafTextNodesWithin(container, "div,span,p,small,strong").find((node) => {
      if (node === labelNode) return false;
      const txt = (node.textContent || "").trim();
      return /^\d+$/.test(txt);
    });
    if (valueNode) valueNode.textContent = String(Math.max(0, Math.round(count)));
  });
}

function findTripSummaryHeading() {
  return queryLeafTextNodesWithin(document, TEXT_LEAF_SELECTORS).find((node) => {
    const txt = (node.textContent || "").replace(/\s+/g, " ").trim();
    return txt === "Trip Summary" || txt === "Resume du trajet";
  }) as HTMLElement | undefined;
}

function patchTripSummarySavings(route: RouteSnapshot | null) {
  if (!route) return;
  const limitCost = Number(route.total_limit_trip_cost_all_in_eur ?? Number.NaN);
  const ecoCost = Number(route.total_eco_trip_cost_all_in_eur ?? Number.NaN);
  if (!Number.isFinite(limitCost) || !Number.isFinite(ecoCost) || limitCost <= 0) return;

  const costSaved = Math.max(0, limitCost - ecoCost);
  const pctSaved = (costSaved / limitCost) * 100;
  const scope = findTripSummaryHeading()?.parentElement?.parentElement ?? document.body;
  const nodes = queryLeafTextNodesWithin(scope, TEXT_LEAF_SELECTORS);
  const labelNode = nodes.find((node) => {
    const txt = (node.textContent || "").trim();
    return txt === "Energy Saved" || txt === "Energie economisee";
  });
  if (!labelNode) return;

  labelNode.textContent = labelNode.textContent?.trim() === "Energy Saved" ? "Cost Saved" : "Economies";

  const card = labelNode.parentElement;
  if (!card) return;

  const cardNodes = queryLeafTextNodesWithin(card, "div,span,p,small,strong");
  const valueNode = cardNodes.find((node) => {
    const txt = (node.textContent || "").trim();
    return /^\d+(?:[.,]\d+)?\s*(kwh|eur)$/i.test(txt);
  });
  if (valueNode) valueNode.textContent = `${costSaved.toFixed(2)} EUR`;

  const savingsNode = cardNodes.find((node) => {
    const txt = (node.textContent || "").trim();
    return /\d+(?:[.,]\d+)?%\s*(savings|economies)/i.test(txt);
  });
  if (savingsNode) savingsNode.textContent = `(${pctSaved.toFixed(1)}% savings)`;
}

function upsertRouteInsights(route: RouteSnapshot | null) {
  const mount = document.querySelector("[data-ecospeed-physics-summary='true']") as HTMLDivElement | null;
  if (mount) mount.remove();
  void route;
}

export default function NewTripInsightsBridge() {
  const [, setRoute] = useState<RouteSnapshot | null>(null);

  useEffect(() => {
    let lastTotalSaved = Number.NaN;

    const normalizeNow = () => {
      const trips = readTrips();
      const lastRoute = readLastRoute();
      const changedAttach = attachLatestRouteSavings(trips, lastRoute);
      const changedNorm = normalizeTripsWithRealProgress(trips);
      if (changedAttach || changedNorm) writeTrips(trips);
      const totalSaved = trips.reduce((sum, t) => sum + Math.max(0, Number(t.costSavedEur ?? 0)), 0);
      if (!Number.isFinite(lastTotalSaved) || Math.abs(lastTotalSaved - totalSaved) > 0.001) {
        patchTripsCompletedText(totalSaved);
        lastTotalSaved = totalSaved;
      }
      patchGreetingText();
      patchChargeDurationLabels();
      patchRecentTripsRechargeCounts(trips);
      patchTripSummarySavings(lastRoute);
      upsertRouteInsights(lastRoute);
      if (lastRoute) setRoute(lastRoute);
    };

    normalizeNow();
    const interval = window.setInterval(normalizeNow, 4000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") normalizeNow();
    };
    window.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("storage", normalizeNow);

    const rawFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await rawFetch(...args);
      try {
        const input = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : "";
        if (input.includes("/api/route") && res.ok) {
          const snap = buildRouteSnapshot(await res.clone().json());
          persistRouteSnapshot(snap);
          patchTripSummarySavings(snap);
          upsertRouteInsights(snap);
          setRoute(snap);
        }
      } catch {}
      return res;
    };

    const XHROpen = window.XMLHttpRequest.prototype.open;
    const XHRSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      (this as XMLHttpRequest & { __ecospeedUrl?: string }).__ecospeedUrl = String(url ?? "");
      return XHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    window.XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this as XMLHttpRequest & { __ecospeedUrl?: string };
      const onLoadEnd = () => {
        try {
          if (!xhr.__ecospeedUrl?.includes("/api/route")) return;
          if (xhr.status < 200 || xhr.status >= 300) return;
          const raw = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : xhr.response;
          if (!raw) return;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          const snap = buildRouteSnapshot(parsed);
          persistRouteSnapshot(snap);
          patchTripSummarySavings(snap);
          upsertRouteInsights(snap);
          setRoute(snap);
        } catch {}
      };
      xhr.addEventListener("loadend", onLoadEnd, { once: true });
      return XHRSend.call(this, body);
    };

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("storage", normalizeNow);
      window.fetch = rawFetch;
      window.XMLHttpRequest.prototype.open = XHROpen;
      window.XMLHttpRequest.prototype.send = XHRSend;
    };
  }, []);

  return null;
}
