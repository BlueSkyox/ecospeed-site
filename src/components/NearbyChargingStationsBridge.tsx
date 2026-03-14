"use client";

import { useEffect } from "react";

type UserCoords = {
  lat: number;
  lon: number;
  ts: number;
};

const USER_COORDS_KEY = "ecospeed_user_coords_v1";
const USER_COORDS_MAX_AGE_MS = 30 * 60 * 1000;
const NEARBY_RADIUS_KM = 10;
const COORDS_REFRESH_MS = 60 * 1000;
const STATIONS_REFRESH_MS = 2 * 60 * 1000;

function readCoords(): UserCoords | null {
  try {
    const raw = window.localStorage.getItem(USER_COORDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserCoords>;
    const lat = Number(parsed.lat ?? Number.NaN);
    const lon = Number(parsed.lon ?? Number.NaN);
    const ts = Number(parsed.ts ?? Number.NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ts)) return null;
    if (Date.now() - ts > USER_COORDS_MAX_AGE_MS) return null;
    return { lat, lon, ts };
  } catch {
    return null;
  }
}

function writeCoords(coords: UserCoords) {
  window.localStorage.setItem(USER_COORDS_KEY, JSON.stringify(coords));
}

function patchChargingStationsUrl(rawUrl: string, coords: UserCoords | null) {
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return rawUrl;
  }
  if (!url.pathname.includes("/api/charging-stations")) return rawUrl;
  if (coords) {
    url.searchParams.set("lat", coords.lat.toFixed(6));
    url.searchParams.set("lon", coords.lon.toFixed(6));
  }
  url.searchParams.set("radius_km", String(NEARBY_RADIUS_KM));
  url.searchParams.set("refresh", "1");
  url.searchParams.set("refresh_bucket", String(Math.floor(Date.now() / 60_000)));
  return rawUrl.startsWith("http://") || rawUrl.startsWith("https://") ? url.toString() : `${url.pathname}${url.search}`;
}

export default function NearbyChargingStationsBridge() {
  useEffect(() => {
    let latestCoords = readCoords();
    let disposed = false;
    let permissionStatus: PermissionStatus | null = null;
    let coordsTimer: number | null = null;
    let stationsTimer: number | null = null;
    const rawFetch = window.fetch.bind(window);

    const setCoords = (lat: number, lon: number) => {
      latestCoords = {
        lat,
        lon,
        ts: Date.now(),
      };
      writeCoords(latestCoords);
    };

    const requestCoords = () => {
      if (disposed || !("geolocation" in navigator)) return;
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setCoords(position.coords.latitude, position.coords.longitude);
        },
        () => {},
        {
          enableHighAccuracy: false,
          maximumAge: 10 * 60 * 1000,
          timeout: 5000,
        },
      );
    };

    const refreshStations = async () => {
      if (disposed) return;
      const coords = latestCoords ?? readCoords();
      if (!coords) return;
      try {
        const url = patchChargingStationsUrl(`/api/charging-stations?ts=${Date.now()}`, coords);
        const response = await rawFetch(url, { cache: "no-store" });
        if (!response.ok) return;
        const stations = await response.json();
        window.dispatchEvent(
          new CustomEvent("ecospeed-nearby-stations-updated", {
            detail: { coords, stations },
          }),
        );
      } catch {}
    };

    const startPeriodicRefresh = () => {
      if (coordsTimer !== null) window.clearInterval(coordsTimer);
      coordsTimer = window.setInterval(() => {
        requestCoords();
      }, COORDS_REFRESH_MS);

      if (stationsTimer !== null) window.clearInterval(stationsTimer);
      stationsTimer = window.setInterval(() => {
        void refreshStations();
      }, STATIONS_REFRESH_MS);
    };

    if ("geolocation" in navigator && "permissions" in navigator && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((status) => {
          if (disposed) return;
          permissionStatus = status;
          if (status.state !== "denied") {
            requestCoords();
            startPeriodicRefresh();
            void refreshStations();
          }
          status.onchange = () => {
            if (status.state !== "denied") {
              requestCoords();
              startPeriodicRefresh();
              void refreshStations();
            }
          };
        })
        .catch(() => {
          requestCoords();
          startPeriodicRefresh();
          void refreshStations();
        });
    } else if ("geolocation" in navigator) {
      requestCoords();
      startPeriodicRefresh();
      void refreshStations();
    }

    window.fetch = async (...args) => {
      let input = args[0];
      const init = args[1];
      const coords = latestCoords ?? readCoords();
      if (typeof input === "string") {
        input = patchChargingStationsUrl(input, coords);
      } else if (input instanceof Request) {
        const nextUrl = patchChargingStationsUrl(input.url, coords);
        if (nextUrl !== input.url) input = new Request(nextUrl, input);
      }
      return rawFetch(input as RequestInfo | URL, init);
    };

    const xhrOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      const coords = latestCoords ?? readCoords();
      const nextUrl = typeof url === "string" ? patchChargingStationsUrl(url, coords) : patchChargingStationsUrl(url.toString(), coords);
      return xhrOpen.call(this, method, nextUrl, async ?? true, username ?? null, password ?? null);
    };

    return () => {
      disposed = true;
      if (permissionStatus) permissionStatus.onchange = null;
      if (coordsTimer !== null) window.clearInterval(coordsTimer);
      if (stationsTimer !== null) window.clearInterval(stationsTimer);
      window.fetch = rawFetch;
      window.XMLHttpRequest.prototype.open = xhrOpen;
    };
  }, []);

  return null;
}
