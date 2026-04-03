export const GRAVITY = 9.81;
export const RHO_AIR_BASE = 1.225;
export const ETA_DRIVE = 0.92;
export const ETA_REGEN = 0.6;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Calcule la densité de l'air ajustée selon la température.
 * Plus il fait chaud, plus l'air est léger (et la traînée baisse légèrement).
 */
export const getAirDensity = (tempCelsius) => {
  const safeTemp = Number.isFinite(tempCelsius) ? tempCelsius : 15;
  return 1.293 * (273 / (273 + safeTemp));
};

/**
 * Calcule le coefficient de roulement selon l'intensité de pluie (mm/h).
 * - sec: 0.007
 * - formule progressive: 0.007 + 0.0008 * pluie
 * - plafonnée à 0.015 pour éviter les valeurs non physiques.
 */
export const getRollingCoeff = (precipMmH) => {
  const safePrecip = Math.max(0, Number(precipMmH) || 0);
  if (safePrecip === 0) return 0.007;
  const cr = 0.007 + 0.0008 * safePrecip;
  return Math.min(cr, 0.015);
};

/**
 * Calcul de la puissance HVAC consommée (W).
 * Le besoin thermique brut est ajusté par un COP différent
 * en mode chauffage vs climatisation.
 */
export const calculateHvacPower = (tCabin, tExt) => {
  const safeCabin = Number.isFinite(tCabin) ? tCabin : 21;
  const safeExt = Number.isFinite(tExt) ? tExt : 15;

  const deltaT = Math.abs(safeCabin - safeExt);
  const k = 150;
  const rawPower = k * deltaT;
  const COP = safeExt < safeCabin ? 2.5 : 3.0;

  return rawPower / COP;
};

/**
 * Calcul de l'énergie consommée sur un segment (Wh).
 * Inclut roulement, aérodynamique, potentiel gravitationnel,
 * et HVAC, avec rendement chaîne de traction + régénération.
 */
export const calculateSegmentEnergy = (params) => {
  const {
    distM,
    deltaH,
    vKmh,
    mass,
    cx,
    area,
    tExt,
    precip,
    hvacW,
  } = params;

  const safeDist = Math.max(0, Number(distM) || 0);
  if (safeDist <= 0) return 0;

  const safeMass = Math.max(1, Number(mass) || 1800);
  const safeCx = clamp(Number(cx) || 0.29, 0.15, 0.9);
  const safeArea = clamp(Number(area) || 2.2, 1.2, 3.6);
  const safeVms = Math.max(0.1, (Number(vKmh) || 1) / 3.6);
  const safeDeltaH = Number.isFinite(deltaH) ? deltaH : 0;
  const safeHvac = Math.max(0, Number(hvacW) || 0);

  const rho = getAirDensity(Number(tExt));
  const cr = getRollingCoeff(precip);
  const timeSec = safeDist / safeVms;

  const eRoll = safeMass * GRAVITY * cr * safeDist;
  const eAero = 0.5 * rho * safeCx * safeArea * Math.pow(safeVms, 2) * safeDist;
  const ePot = safeMass * GRAVITY * safeDeltaH;

  let totalJoules = (eRoll + eAero) / ETA_DRIVE;

  if (ePot > 0) {
    totalJoules += ePot / ETA_DRIVE;
  } else {
    totalJoules += ePot * ETA_REGEN;
  }

  const eHvac = safeHvac * timeSec;
  totalJoules += eHvac;

  const energyWh = totalJoules / 3600;
  return clamp(energyWh, -5000, 50000);
};

/**
 * Vitesse éco optimale segment par segment.
 */
export const calculateOptimalEcoSpeed = (mass, cr, rho, cx, area, speedLimit) => {
  const safeMass = Math.max(1, Number(mass) || 1800);
  const safeCr = Math.max(0.005, Number(cr) || 0.007);
  const safeRho = Math.max(0.9, Number(rho) || RHO_AIR_BASE);
  const safeCx = Math.max(0.15, Number(cx) || 0.29);
  const safeArea = Math.max(1.2, Number(area) || 2.2);
  const safeLimit = Math.max(20, Number(speedLimit) || 90);

  const vOptimalMs = Math.pow((safeMass * GRAVITY * safeCr) / (safeRho * safeCx * safeArea), 1 / 3);
  const vOptimalKmh = vOptimalMs * 3.6;
  const minSafeSpeed = safeLimit > 70 ? 60 : 30;

  return Math.min(safeLimit, Math.max(minSafeSpeed, vOptimalKmh));
};
