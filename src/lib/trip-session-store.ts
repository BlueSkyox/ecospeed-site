import { promises as fs } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { normalizeHvacMode, type HvacMode } from "@/lib/ev";

export type TripSession = {
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
  hvacMode?: HvacMode;
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

type TripHistory = {
  distance_validee_km: number;
  segments_valides: NonNullable<TripSession["logbook"]>;
};

type StoredTripSession = {
  session: TripSession;
  updatedAt: string;
  expiresAt: string;
};

type LocalStore = Record<string, StoredTripSession>;
type LegacyTripSession = TripSession & { climateIntensityPct?: number; hvacMode?: HvacMode };

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const REDIS_KEY_PREFIX = "ecospeed:trip-session:";
const STORE_FILE = path.join(process.cwd(), ".data", "trip-sessions.json");

let redisClient: Redis | null | undefined;
let localStoreQueue = Promise.resolve();

function getRedisClient() {
  if (redisClient !== undefined) return redisClient;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    redisClient = null;
    return redisClient;
  }
  redisClient = Redis.fromEnv();
  return redisClient;
}

function redisKey(tripId: string) {
  return `${REDIS_KEY_PREFIX}${tripId}`;
}

function normalizeTripSession(session: LegacyTripSession): TripSession {
  return {
    ...session,
    hvacMode: normalizeHvacMode(session.hvacMode, session.climateIntensityPct),
  };
}

function buildStoredSession(session: TripSession, now = Date.now()): StoredTripSession {
  return {
    session: normalizeTripSession(session),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
}

function isExpired(record: StoredTripSession, now = Date.now()) {
  return Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) <= now;
}

function buildTripHistory(session: TripSession): TripHistory {
  const distance = Number(session.distanceKm ?? 0);
  return {
    distance_validee_km: distance,
    segments_valides: distance > 0 ? session.logbook ?? [] : [],
  };
}

async function ensureLocalStoreDir() {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
}

async function readLocalStoreRaw(): Promise<LocalStore> {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as LocalStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return {};
  }
}

async function writeLocalStore(store: LocalStore) {
  await ensureLocalStoreDir();
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function purgeExpiredRecords(store: LocalStore, now = Date.now()) {
  let mutated = false;
  for (const [tripId, record] of Object.entries(store)) {
    if (!record || typeof record !== "object" || isExpired(record, now)) {
      delete store[tripId];
      mutated = true;
    }
  }
  return mutated;
}

async function withLocalStoreLock<T>(task: () => Promise<T>) {
  const run = localStoreQueue.then(task, task);
  localStoreQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function saveLocalSession(session: TripSession) {
  return withLocalStoreLock(async () => {
    const store = await readLocalStoreRaw();
    purgeExpiredRecords(store);
    store[session.tripId] = buildStoredSession(session);
    await writeLocalStore(store);
    return session;
  });
}

async function getLocalStoredSession(tripId: string): Promise<StoredTripSession | null> {
  const store = await readLocalStoreRaw();
  if (purgeExpiredRecords(store)) await writeLocalStore(store);
  return store[tripId] ?? null;
}

async function saveRedisSession(session: TripSession) {
  const redis = getRedisClient();
  if (!redis) return null;
  const record = buildStoredSession(session);
  await redis.set(redisKey(session.tripId), record, { ex: SESSION_TTL_SECONDS });
  return session;
}

async function getRedisStoredSession(tripId: string): Promise<StoredTripSession | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const record = await redis.get<StoredTripSession>(redisKey(tripId));
  if (!record) return null;
  if (!isExpired(record)) return record;
  await redis.del(redisKey(tripId));
  return null;
}

export async function saveTripSession(session: TripSession) {
  try {
    const stored = await saveRedisSession(session);
    if (stored) return stored;
  } catch {}
  return await saveLocalSession(session);
}

export async function getTripSession(tripId: string) {
  try {
    const stored = await getRedisStoredSession(tripId);
    if (stored) return normalizeTripSession(stored.session as LegacyTripSession);
  } catch {}
  const local = await getLocalStoredSession(tripId);
  return local ? normalizeTripSession(local.session as LegacyTripSession) : null;
}

export async function markTripActive(tripId: string, batteryPctAfter?: number) {
  const cur = await getTripSession(tripId);
  if (!cur) return null;
  const next: TripSession = {
    ...cur,
    status: "in_progress",
    batteryPctAfter: batteryPctAfter ?? cur.batteryPctAfter ?? cur.batteryPctBefore,
  };
  await saveTripSession(next);
  return next;
}

export async function getTripHistory(tripId: string) {
  const cur = await getTripSession(tripId);
  if (!cur) return null;
  return buildTripHistory(cur);
}
