"use client";

import { useEffect, useState } from "react";

type RouteSnapshot = {
  weather_avg_temp_c?: number;
  weather_avg_rain_mmh?: number;
  weather_impact_eco_kwh?: number;
  weather_impact_eco_eur?: number;
  total_eco_trip_cost_all_in_eur?: number;
  total_limit_trip_cost_all_in_eur?: number;
};

type StoredTrip = {
  id?: string;
  createdAt?: number;
  distanceKm?: number;
  ecoEnergyKwh?: number;
  energySavedKwh?: number;
  actualEnergyKwh?: number | null;
  costSavedEur?: number;
  plannedDistanceKmBase?: number;
  plannedEnergySavedKwhBase?: number;
  plannedCostSavedEurBase?: number;
};

const TRIPS_KEY = "ecospeed_trips_v1";
const LAST_ROUTE_KEY = "ecospeed_last_route_v1";

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
  return parseJson<RouteSnapshot>(window.localStorage.getItem(LAST_ROUTE_KEY));
}

function attachLatestRouteSavings(trips: StoredTrip[], route: RouteSnapshot | null) {
  if (!route || trips.length === 0) return false;
  const latest = trips[0];
  if (!latest) return false;
  if (latest.plannedCostSavedEurBase !== undefined) return false;
  const limit = Number(route.total_limit_trip_cost_all_in_eur ?? Number.NaN);
  const eco = Number(route.total_eco_trip_cost_all_in_eur ?? Number.NaN);
  if (!Number.isFinite(limit) || !Number.isFinite(eco)) return false;
  latest.plannedCostSavedEurBase = Math.max(0, limit - eco);
  return true;
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

function patchTripsCompletedText(totalSavedEur: number) {
  const nodes = Array.from(document.querySelectorAll("div,span,p,small,strong"));
  for (const n of nodes) {
    const txt = (n.textContent || "").trim();
    if (!txt) continue;
    const isTrips =
      /trips completed/i.test(txt) ||
      /trajets?\s+termin/i.test(txt);
    if (!isTrips) continue;
    const clean = txt.replace(/\s*\|\s*(Total saved|Total économisé).*$/i, "");
    n.textContent = `${clean} | Total économisé: ${totalSavedEur.toFixed(2)} EUR`;
    break;
  }
}

export default function NewTripInsightsBridge() {
  const [route, setRoute] = useState<RouteSnapshot | null>(null);

  useEffect(() => {
    const normalizeNow = () => {
      const trips = readTrips();
      const lastRoute = readLastRoute();
      const changedAttach = attachLatestRouteSavings(trips, lastRoute);
      const changedNorm = normalizeTripsWithRealProgress(trips);
      if (changedAttach || changedNorm) writeTrips(trips);
      const totalSaved = trips.reduce((sum, t) => sum + Math.max(0, Number(t.costSavedEur ?? 0)), 0);
      patchTripsCompletedText(totalSaved);
      if (lastRoute) setRoute(lastRoute);
    };

    normalizeNow();
    const interval = window.setInterval(normalizeNow, 1200);

    const rawSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (key: string, value: string) => {
      rawSetItem(key, value);
      if (key === TRIPS_KEY || key === LAST_ROUTE_KEY) {
        window.setTimeout(normalizeNow, 20);
      }
    };

    const rawFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await rawFetch(...args);
      try {
        const input = String(args[0] ?? "");
        if (input.includes("/api/route") && res.ok) {
          const clone = res.clone();
          const data = await clone.json();
          const snap: RouteSnapshot = {
            weather_avg_temp_c: Number(data?.weather_avg_temp_c ?? Number.NaN),
            weather_avg_rain_mmh: Number(data?.weather_avg_rain_mmh ?? Number.NaN),
            weather_impact_eco_kwh: Number(data?.weather_impact_eco_kwh ?? Number.NaN),
            weather_impact_eco_eur: Number(data?.weather_impact_eco_eur ?? Number.NaN),
            total_eco_trip_cost_all_in_eur: Number(data?.total_eco_trip_cost_all_in_eur ?? Number.NaN),
            total_limit_trip_cost_all_in_eur: Number(data?.total_limit_trip_cost_all_in_eur ?? Number.NaN),
          };
          window.localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(snap));
          setRoute(snap);
        }
      } catch {}
      return res;
    };

    return () => {
      window.clearInterval(interval);
      window.fetch = rawFetch;
      window.localStorage.setItem = rawSetItem;
    };
  }, []);

  if (!route) return null;
  return (
    <div className="newtrip-weather-impact">
      <div className="newtrip-weather-title">Meteo et impact (Nouveau trajet)</div>
      <div>
        Temp: {Number(route.weather_avg_temp_c ?? 0).toFixed(1)} C | Pluie: {Number(route.weather_avg_rain_mmh ?? 0).toFixed(2)} mm/h
      </div>
      <div>
        Impact conso: +{Number(route.weather_impact_eco_kwh ?? 0).toFixed(2)} kWh ({Number(route.weather_impact_eco_eur ?? 0).toFixed(2)} EUR)
      </div>
    </div>
  );
}

