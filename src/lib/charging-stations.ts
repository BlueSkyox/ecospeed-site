import type { ChargingStation } from "@/lib/charging-context";

type OcmPoi = {
  AddressInfo?: {
    Title?: string;
    Latitude?: number;
    Longitude?: number;
    AddressLine1?: string;
    Town?: string;
    StateOrProvince?: string;
    Postcode?: string;
  };
  OperatorInfo?: {
    Title?: string;
  };
  StatusType?: {
    IsOperational?: boolean;
  };
  Connections?: Array<{
    PowerKW?: number;
  }>;
};

type OverpassElement = {
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

export function estimatePricePerKwh(powerKw: number) {
  if (powerKw >= 300) return 0.69;
  if (powerKw >= 200) return 0.62;
  if (powerKw >= 150) return 0.56;
  if (powerKw >= 100) return 0.49;
  if (powerKw >= 50) return 0.43;
  return 0.35;
}

function formatPrice(powerKw: number) {
  return `${estimatePricePerKwh(powerKw).toFixed(2)} EUR/kWh`;
}

const CORE_STATIONS: ChargingStation[] = [
  { name: "Ionity Paris Sud", latitude: 48.604, longitude: 2.436, powerKw: 350, status: "Dispo", operator: "Ionity", address: "A6, Essonne", price: formatPrice(350) },
  { name: "Tesla Supercharger Paris La Defense", latitude: 48.8925, longitude: 2.2383, powerKw: 250, status: "Dispo", operator: "Tesla", address: "La Defense, Paris", price: formatPrice(250) },
  { name: "TotalEnergies Champs Elysees", latitude: 48.8698, longitude: 2.3081, powerKw: 175, status: "Dispo", operator: "TotalEnergies", address: "Champs Elysees, Paris", price: formatPrice(175) },
  { name: "Electra Paris Opera", latitude: 48.8706, longitude: 2.3317, powerKw: 150, status: "Dispo", operator: "Electra", address: "Opera, Paris", price: formatPrice(150) },
  { name: "Fastned Orly", latitude: 48.728, longitude: 2.379, powerKw: 300, status: "Dispo", operator: "Fastned", address: "Orly", price: formatPrice(300) },
  { name: "Ionity Lyon Est", latitude: 45.734, longitude: 4.95, powerKw: 350, status: "Dispo", operator: "Ionity", address: "A43, Lyon Est", price: formatPrice(350) },
  { name: "Ionity Marseille Nord", latitude: 43.349, longitude: 5.361, powerKw: 350, status: "Dispo", operator: "Ionity", address: "Marseille Nord", price: formatPrice(350) },
  { name: "Fastned Bordeaux", latitude: 44.84, longitude: -0.58, powerKw: 300, status: "Dispo", operator: "Fastned", address: "Bordeaux", price: formatPrice(300) },
  { name: "Ionity Toulouse", latitude: 43.604, longitude: 1.444, powerKw: 350, status: "Dispo", operator: "Ionity", address: "Toulouse", price: formatPrice(350) },
  { name: "Ionity Lille", latitude: 50.631, longitude: 3.06, powerKw: 350, status: "Dispo", operator: "Ionity", address: "Lille", price: formatPrice(350) },
];

function buildExtendedFallback() {
  const out: ChargingStation[] = [];
  const deltas = [
    [0, 0],
    [0.07, 0.03],
    [-0.05, 0.04],
    [0.04, -0.06],
  ];
  for (const base of CORE_STATIONS) {
    for (let i = 0; i < deltas.length; i += 1) {
      const [dLat, dLon] = deltas[i];
      const power = Math.max(120, base.powerKw - i * 30);
      out.push({
        name: `${base.name} ${i + 1}`,
        latitude: Number((base.latitude + dLat).toFixed(6)),
        longitude: Number((base.longitude + dLon).toFixed(6)),
        powerKw: power,
        status: "Dispo",
        operator: base.operator ?? "Operator",
        address: `${base.address ?? base.name} - zone ${i + 1}`,
        price: formatPrice(power),
      });
    }
  }
  return out;
}

export const FALLBACK_STATIONS: ChargingStation[] = buildExtendedFallback();

function mapOcmToStation(poi: OcmPoi) {
  const lat = Number(poi.AddressInfo?.Latitude);
  const lon = Number(poi.AddressInfo?.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = (poi.AddressInfo?.Title ?? "Charging Station").trim();
  const maxPower = Math.max(
    22,
    ...(poi.Connections ?? []).map((connection) => Number(connection.PowerKW ?? 0)).filter((value) => Number.isFinite(value)),
  );
  const operator = (poi.OperatorInfo?.Title ?? "").trim();
  const address = [
    poi.AddressInfo?.AddressLine1,
    poi.AddressInfo?.Town,
    poi.AddressInfo?.StateOrProvince,
    poi.AddressInfo?.Postcode,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    name,
    latitude: lat,
    longitude: lon,
    powerKw: Math.round(maxPower),
    status: poi.StatusType?.IsOperational === false ? "Indispo" : "Dispo",
    operator: operator || undefined,
    address: address || undefined,
    price: formatPrice(Math.round(maxPower)),
  } as ChargingStation;
}

function parseOverpassPower(rawValue?: string) {
  if (!rawValue) return 50;
  const normalized = rawValue.toLowerCase().replace(",", ".");
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 50;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 50;
  return normalized.includes("mw") ? value * 1000 : value;
}

function mapOverpassToStation(element: OverpassElement) {
  const lat = Number(element.lat ?? element.center?.lat ?? Number.NaN);
  const lon = Number(element.lon ?? element.center?.lon ?? Number.NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const tags = element.tags ?? {};
  const name = tags.name || tags.operator || "Charging Station";
  const powerKw = Math.max(22, parseOverpassPower(tags.maxpower));
  const operator = tags.operator || undefined;
  const address = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]].filter(Boolean).join(" ");
  const status = tags.access === "private" ? "Restreint" : "Dispo";

  return {
    name,
    latitude: lat,
    longitude: lon,
    powerKw: Math.round(powerKw),
    status,
    operator,
    address: address || undefined,
    price: formatPrice(Math.round(powerKw)),
  } as ChargingStation;
}

function dedupeStations(stations: ChargingStation[]) {
  const out = new Map<string, ChargingStation>();
  for (const station of stations) {
    const key = `${station.name}|${station.latitude.toFixed(4)}|${station.longitude.toFixed(4)}`;
    if (!out.has(key)) out.set(key, station);
  }
  return [...out.values()];
}

export async function fetchOpenChargeMapStations(): Promise<ChargingStation[]> {
  const url =
    "https://api.openchargemap.io/v3/poi/?output=json&countrycode=FR&maxresults=1200&compact=true&verbose=false";
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("OpenChargeMap unavailable");
  const raw = (await response.json()) as OcmPoi[];
  return dedupeStations(raw.map(mapOcmToStation).filter((station): station is ChargingStation => Boolean(station)));
}

export async function fetchOverpassStations(): Promise<ChargingStation[]> {
  const query = `
    [out:json][timeout:20];
    (
      node["amenity"="charging_station"](46.2, -5.4, 51.3, 8.8);
      way["amenity"="charging_station"](46.2, -5.4, 51.3, 8.8);
      relation["amenity"="charging_station"](46.2, -5.4, 51.3, 8.8);
    );
    out center tags;
  `;
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Overpass unavailable");
  const json = (await response.json()) as { elements?: OverpassElement[] };
  return dedupeStations((json.elements ?? []).map(mapOverpassToStation).filter((station): station is ChargingStation => Boolean(station)));
}
