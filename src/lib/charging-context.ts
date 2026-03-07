export type ChargingStation = {
  name: string;
  latitude: number;
  longitude: number;
  powerKw: number;
  status: string;
  operator?: string;
  address?: string;
  price?: string;
  distanceKm?: number;
};

type RouteChargingContext = {
  ts: number;
  stations: ChargingStation[];
};

let context: RouteChargingContext | null = null;

export function setRouteChargingContext(stations: ChargingStation[]) {
  context = { ts: Date.now(), stations };
}

export function getRouteChargingContext(maxAgeMs = 10 * 60_000): ChargingStation[] | null {
  if (!context) return null;
  if (Date.now() - context.ts > maxAgeMs) return null;
  return context.stations;
}
