type TripSession = {
  tripId: string;
  status: "planned" | "in_progress" | "paused" | "completed" | "abandoned" | "active";
  pausedAt: string;
  segmentIndex?: number;
  batteryPctBefore?: number;
  batteryPctAfter?: number;
  didRecharge?: boolean;
  notes?: string;
  remainingCoords?: [number, number][];
  remainingEcoSpeedsKmh?: number[];
  comfortTempC?: number;
  vehicleProfile?: {
    empty_mass?: number;
    extra_load?: number;
    drag_coefficient?: number;
    frontal_area?: number;
    rolling_resistance?: number;
    motor_efficiency?: number;
    regen_efficiency?: number;
    aux_power_kw?: number;
    battery_kwh?: number;
    max_charge_kw?: number;
  };
  distanceKm?: number;
  logbook?: Array<{
    id_segment: number;
    distance_km: number;
    conso_reelle_kwh?: number;
    conso_theorique_kwh?: number;
    cout_eur?: number;
    meteo?: { temperature_c?: number; pluie_mmh?: number };
  }>;
};

const store = new Map<string, TripSession>();

export function saveTripSession(session: TripSession) {
  store.set(session.tripId, session);
  return session;
}

export function getTripSession(tripId: string) {
  return store.get(tripId) ?? null;
}

export function markTripActive(tripId: string, batteryPctAfter?: number) {
  const cur = store.get(tripId);
  if (!cur) return null;
  const next: TripSession = {
    ...cur,
    status: "in_progress",
    batteryPctAfter: batteryPctAfter ?? cur.batteryPctAfter ?? cur.batteryPctBefore,
  };
  store.set(tripId, next);
  return next;
}

export function getTripHistory(tripId: string) {
  const cur = store.get(tripId);
  if (!cur) return null;
  const distance = Number(cur.distanceKm ?? 0);
  return {
    distance_validee_km: distance,
    segments_valides: distance > 0 ? cur.logbook ?? [] : [],
  };
}
