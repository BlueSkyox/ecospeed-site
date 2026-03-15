import snapshotStations from "@/data/charging-stations.snapshot.json";
import type { ChargingStation } from "@/lib/charging-context";

type OverpassElement = {
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

type DataGouvDatasetResource = {
  title?: string;
  latest?: string;
  url?: string;
};

type DataGouvDatasetResponse = {
  resources?: DataGouvDatasetResource[];
};

type CsvRow = Record<string, string>;

type FetchOverpassOptions = {
  bboxes?: BoundingBox[];
  focus?: {
    lat: number;
    lon: number;
    radiusKm?: number;
  };
};

type IrveResourceUrls = {
  staticUrl: string;
  dynamicUrl: string | null;
};

type DynamicPointState = {
  operational: boolean;
  available: boolean;
  occupied: boolean;
};

type StationAggregate = {
  name: string;
  latitude: number;
  longitude: number;
  operator?: string;
  address?: string;
  powerKw: number;
  restricted: boolean;
  dynamicStates: DynamicPointState[];
};

export type BoundingBox = [south: number, west: number, north: number, east: number];

const DATA_GOUV_IRVE_DATASET_API_URL =
  "https://www.data.gouv.fr/api/1/datasets/public-charging-stations-for-electric-cars-from-several-cpos/";
const DEFAULT_FRANCE_BBOX: BoundingBox = [42.3, -5.4, 51.3, 8.8];
const DEFAULT_UNKNOWN_POWER_KW = 11;
const DEFAULT_OVERPASS_LAT_TILE_DEG = 2.2;
const DEFAULT_OVERPASS_LON_TILE_DEG = 2.6;
const DATA_GOUV_METADATA_TTL_MS = 30 * 60 * 1000;
const DATA_GOUV_STATIONS_TTL_MS = 15 * 60 * 1000;

const ESTIMATED_OPERATOR_PRICE_TABLE_EUR_PER_KWH: Array<{ match: string[]; price: number }> = [
  { match: ["tesla"], price: 0.43 },
  { match: ["ionity"], price: 0.59 },
  { match: ["fastned"], price: 0.64 },
  { match: ["electra"], price: 0.49 },
  { match: ["totalenergies", "total energies", "total"], price: 0.54 },
  { match: ["allego"], price: 0.59 },
  { match: ["izivia"], price: 0.52 },
  { match: ["freshmile"], price: 0.45 },
  { match: ["eborn"], price: 0.49 },
];

let dataGouvResourceCache: { expiresAt: number; value: IrveResourceUrls } | null = null;
let dataGouvStationsCache: { expiresAt: number; value: ChargingStation[] } | null = null;

function normalizeText(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeOperatorKey(operator?: string) {
  return normalizeText(operator)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeLooseKey(value?: string) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function clampLatitude(value: number) {
  return Math.max(-90, Math.min(90, value));
}

function clampLongitude(value: number) {
  if (value > 180) return 180;
  if (value < -180) return -180;
  return value;
}

function normalizeBoundingBox(bbox: BoundingBox): BoundingBox {
  const south = clampLatitude(Math.min(bbox[0], bbox[2]));
  const north = clampLatitude(Math.max(bbox[0], bbox[2]));
  const west = clampLongitude(Math.min(bbox[1], bbox[3]));
  const east = clampLongitude(Math.max(bbox[1], bbox[3]));
  return [south, west, north, east];
}

function dedupeBoundingBoxes(boxes: BoundingBox[]) {
  const out = new Map<string, BoundingBox>();
  for (const box of boxes) {
    const normalized = normalizeBoundingBox(box);
    const key = normalized.map((value) => value.toFixed(4)).join("|");
    if (!out.has(key)) out.set(key, normalized);
  }
  return [...out.values()];
}

function tileBoundingBox(
  bbox: BoundingBox,
  maxLatSpanDeg = DEFAULT_OVERPASS_LAT_TILE_DEG,
  maxLonSpanDeg = DEFAULT_OVERPASS_LON_TILE_DEG,
) {
  const [south, west, north, east] = normalizeBoundingBox(bbox);
  const boxes: BoundingBox[] = [];
  for (let lat = south; lat < north; lat += maxLatSpanDeg) {
    for (let lon = west; lon < east; lon += maxLonSpanDeg) {
      boxes.push([
        lat,
        lon,
        Math.min(north, lat + maxLatSpanDeg),
        Math.min(east, lon + maxLonSpanDeg),
      ]);
    }
  }
  return dedupeBoundingBoxes(boxes);
}

export function buildPointBoundingBox(lat: number, lon: number, radiusKm = 30): BoundingBox {
  const safeRadiusKm = Math.max(5, Math.min(150, radiusKm));
  const latDelta = safeRadiusKm / 111;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const lonDelta = safeRadiusKm / (111 * cosLat);
  return normalizeBoundingBox([lat - latDelta, lon - lonDelta, lat + latDelta, lon + lonDelta]);
}

export function buildRouteBoundingBoxes(coords: [number, number][], paddingKm = 25) {
  if (coords.length === 0) return tileBoundingBox(DEFAULT_FRANCE_BBOX);
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of coords) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  const centerLat = (minLat + maxLat) / 2;
  const latPadding = Math.max(0.18, paddingKm / 111);
  const lonPadding = Math.max(0.18, paddingKm / (111 * Math.max(0.2, Math.cos((centerLat * Math.PI) / 180))));
  return tileBoundingBox([minLat - latPadding, minLon - lonPadding, maxLat + latPadding, maxLon + lonPadding]);
}

export function estimatePricePerKwh(powerKw: number, operator?: string) {
  const normalizedOperator = normalizeOperatorKey(operator);
  if (normalizedOperator) {
    for (const entry of ESTIMATED_OPERATOR_PRICE_TABLE_EUR_PER_KWH) {
      if (entry.match.some((token) => normalizedOperator.includes(token))) return entry.price;
    }
  }
  if (powerKw >= 300) return 0.69;
  if (powerKw >= 200) return 0.62;
  if (powerKw >= 150) return 0.56;
  if (powerKw >= 100) return 0.49;
  if (powerKw >= 50) return 0.43;
  return 0.35;
}

function formatPrice(powerKw: number, operator?: string) {
  return `${estimatePricePerKwh(powerKw, operator).toFixed(2)} EUR/kWh`;
}

export const FALLBACK_STATIONS: ChargingStation[] = (snapshotStations as ChargingStation[]).map((station) => ({
  ...station,
  price: formatPrice(Number(station.powerKw ?? DEFAULT_UNKNOWN_POWER_KW), station.operator),
}));

function parseCsvLine(line: string) {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((value) => value.trim());
}

function parseCsv(text: string): CsvRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((header) => normalizeText(header));
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: CsvRow = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = values[index] ?? "";
    }
    return row;
  });
}

function parseNumber(rawValue?: string) {
  const normalized = String(rawValue ?? "").replace(",", ".").trim();
  if (!normalized) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseCoordonneesXY(rawValue?: string) {
  const normalized = normalizeText(rawValue);
  const match = normalized.match(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { latitude: lat, longitude: lon };
}

function parseDynamicPointState(row: CsvRow): DynamicPointState {
  const etat = normalizeLooseKey(row.etat_pdc);
  const occupation = normalizeLooseKey(row.occupation_pdc);
  const operational = etat.includes("en_service") || etat.includes("service");
  const available = occupation.includes("libre") || occupation.includes("disponible");
  const occupied = occupation.includes("occupe") || occupation.includes("occupied");
  return { operational, available, occupied };
}

function isRestrictedAccess(rawValue?: string) {
  const normalized = normalizeLooseKey(rawValue);
  return normalized.includes("reserve") || normalized.includes("prive") || normalized.includes("personnel");
}

function resolveStationStatus(restricted: boolean, dynamicStates: DynamicPointState[]) {
  if (restricted) return "Restreint";
  if (dynamicStates.some((state) => state.operational && state.available)) return "Dispo";
  if (dynamicStates.some((state) => state.operational && state.occupied)) return "Occupe";
  if (dynamicStates.some((state) => state.operational)) return "Dispo";
  if (dynamicStates.length > 0) return "Indispo";
  return "Dispo";
}

function dedupeStations(stations: ChargingStation[]) {
  const out = new Map<string, ChargingStation>();
  for (const station of stations) {
    const key = `${station.name}|${station.latitude.toFixed(4)}|${station.longitude.toFixed(4)}`;
    if (!out.has(key)) out.set(key, station);
  }
  return [...out.values()];
}

function findResourceUrl(resources: DataGouvDatasetResource[], title: string) {
  const match = resources.find((resource) => normalizeLooseKey(resource.title) === title);
  return match?.latest || match?.url || null;
}

async function fetchLatestIrveResourceUrls(): Promise<IrveResourceUrls> {
  const now = Date.now();
  if (dataGouvResourceCache && dataGouvResourceCache.expiresAt > now) return dataGouvResourceCache.value;
  const response = await fetch(DATA_GOUV_IRVE_DATASET_API_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("data.gouv.fr dataset unavailable");
  const dataset = (await response.json()) as DataGouvDatasetResponse;
  const resources = Array.isArray(dataset.resources) ? dataset.resources : [];
  const staticUrl = findResourceUrl(resources, "irve-statique.csv");
  if (!staticUrl) throw new Error("IRVE static resource unavailable");
  const dynamicUrl = findResourceUrl(resources, "irve-dynamique.csv");
  const out = { staticUrl, dynamicUrl };
  dataGouvResourceCache = { expiresAt: now + DATA_GOUV_METADATA_TTL_MS, value: out };
  return out;
}

async function fetchCsvRows(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "text/csv",
    },
  });
  if (!response.ok) throw new Error(`CSV unavailable: ${response.status}`);
  return parseCsv(await response.text());
}

function mapFrenchGovernmentStations(staticRows: CsvRow[], dynamicRows: CsvRow[]) {
  const dynamicByPdc = new Map<string, DynamicPointState>();
  for (const row of dynamicRows) {
    const pointId = normalizeText(row.id_pdc_itinerance);
    if (!pointId) continue;
    dynamicByPdc.set(pointId, parseDynamicPointState(row));
  }

  const grouped = new Map<string, StationAggregate>();

  for (const row of staticRows) {
    const coords = parseCoordonneesXY(row.coordonneesXY);
    if (!coords) continue;
    const name = normalizeText(row.nom_station || row.nom_enseigne || row.nom_operateur || "Charging Station");
    const operator = normalizeText(row.nom_operateur || row.nom_enseigne || row.nom_amenageur);
    const address = normalizeText(row.adresse_station);
    const powerKw = parseNumber(row.puissance_nominale);
    const stationId = normalizeText(row.id_station_itinerance || row.id_station_local || name);
    const key = `${stationId}|${coords.latitude.toFixed(5)}|${coords.longitude.toFixed(5)}`;
    const aggregate = grouped.get(key) ?? {
      name,
      latitude: coords.latitude,
      longitude: coords.longitude,
      operator: operator || undefined,
      address: address || undefined,
      powerKw: DEFAULT_UNKNOWN_POWER_KW,
      restricted: false,
      dynamicStates: [],
    };

    if (Number.isFinite(powerKw) && powerKw > 0) {
      aggregate.powerKw = Math.max(aggregate.powerKw, powerKw);
    }
    if (!aggregate.operator && operator) aggregate.operator = operator;
    if (!aggregate.address && address) aggregate.address = address;
    aggregate.restricted ||= isRestrictedAccess(row.condition_acces);

    const pointId = normalizeText(row.id_pdc_itinerance);
    const dynamicState = pointId ? dynamicByPdc.get(pointId) : null;
    if (dynamicState) aggregate.dynamicStates.push(dynamicState);

    grouped.set(key, aggregate);
  }

  return dedupeStations(
    [...grouped.values()].map((station) => {
      const roundedPower = Math.max(1, Math.round(station.powerKw || DEFAULT_UNKNOWN_POWER_KW));
      const status = resolveStationStatus(station.restricted, station.dynamicStates);
      return {
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        powerKw: roundedPower,
        status,
        operator: station.operator,
        address: station.address,
        price: formatPrice(roundedPower, station.operator),
      } as ChargingStation;
    }),
  );
}

export async function fetchFrenchGovernmentStations(): Promise<ChargingStation[]> {
  const now = Date.now();
  if (dataGouvStationsCache && dataGouvStationsCache.expiresAt > now && dataGouvStationsCache.value.length > 0) {
    return dataGouvStationsCache.value;
  }

  const resources = await fetchLatestIrveResourceUrls();
  const [staticRows, dynamicRows] = await Promise.all([
    fetchCsvRows(resources.staticUrl),
    resources.dynamicUrl
      ? fetchCsvRows(resources.dynamicUrl).catch(() => [] as CsvRow[])
      : Promise.resolve([] as CsvRow[]),
  ]);
  const stations = mapFrenchGovernmentStations(staticRows, dynamicRows);
  if (stations.length === 0) throw new Error("IRVE dataset empty");
  dataGouvStationsCache = { expiresAt: now + DATA_GOUV_STATIONS_TTL_MS, value: stations };
  return stations;
}

function parseOverpassPower(rawValue?: string) {
  if (!rawValue) return DEFAULT_UNKNOWN_POWER_KW;
  const normalized = rawValue.toLowerCase().replace(",", ".");
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return DEFAULT_UNKNOWN_POWER_KW;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_UNKNOWN_POWER_KW;
  const powerKw = normalized.includes("mw") ? value * 1000 : value;
  return Math.max(1, powerKw);
}

function mapOverpassToStation(element: OverpassElement) {
  const lat = Number(element.lat ?? element.center?.lat ?? Number.NaN);
  const lon = Number(element.lon ?? element.center?.lon ?? Number.NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const tags = element.tags ?? {};
  const operator = normalizeText(tags.operator);
  const name = normalizeText(tags.name || tags.operator || "Charging Station");
  const powerKw = parseOverpassPower(tags.maxpower);
  const address = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");
  const status = tags.access === "private" ? "Restreint" : "Dispo";

  return {
    name,
    latitude: lat,
    longitude: lon,
    powerKw: Math.round(powerKw),
    status,
    operator: operator || undefined,
    address: address || undefined,
    price: formatPrice(Math.round(powerKw), operator),
  } as ChargingStation;
}

function buildOverpassQuery(bboxes: BoundingBox[]) {
  const tiledBoxes = bboxes.length > 0 ? dedupeBoundingBoxes(bboxes) : tileBoundingBox(DEFAULT_FRANCE_BBOX);
  const body = tiledBoxes
    .map(
      ([south, west, north, east]) => `
      node["amenity"="charging_station"](${south}, ${west}, ${north}, ${east});
      way["amenity"="charging_station"](${south}, ${west}, ${north}, ${east});
      relation["amenity"="charging_station"](${south}, ${west}, ${north}, ${east});`,
    )
    .join("\n");
  return `
    [out:json][timeout:20];
    (
      ${body}
    );
    out center tags;
  `;
}

export async function fetchOverpassStations(options: FetchOverpassOptions = {}): Promise<ChargingStation[]> {
  const bboxes =
    options.bboxes && options.bboxes.length > 0
      ? options.bboxes
      : options.focus && Number.isFinite(options.focus.lat) && Number.isFinite(options.focus.lon)
        ? [buildPointBoundingBox(options.focus.lat, options.focus.lon, options.focus.radiusKm ?? 30)]
        : tileBoundingBox(DEFAULT_FRANCE_BBOX);
  const query = buildOverpassQuery(bboxes);
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
