"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ChargingStation } from "@/lib/charging-context";
import { estimateChargingMinutesFromSoc } from "@/lib/ev";
import NearbyStationsPanel from "./NearbyStationsPanel";
import WeatherTrendChart from "./WeatherTrendChart";

const TripMap = dynamic(() => import("./TripMap"), { ssr: false });

type Locale = "fr" | "en";
type ResultsTab = "essentials" | "charging" | "analysis" | "trip";

type StationStop = {
  segmentIndex: number;
  batteryLevelAtCharge: number;
  driveTimeFromPreviousStopMin?: number;
  driveDistanceFromPreviousStopKm?: number;
  minimumEnergyToCharge?: number;
  minimumTargetBatteryPct?: number;
  minimumChargingTimeMinutes?: number;
  minimumChargingTimeMinutesRaw?: number;
  targetBatteryPct?: number;
  batteryPctAfterCharge?: number;
  chargingTimeMinutes: number;
  chargingTimeMinutesRaw?: number;
  chargingTimeIsMinimum?: boolean;
  energyToCharge: number;
  estimatedChargeCostEur?: number;
  distKmFromRoute?: number;
  station: ChargingStation;
};

type WeatherEdge = {
  edge_index: number;
  distance_km: number;
  temp_c: number;
  rain_mmh: number;
  wind_kmh?: number;
  rain_crr_multiplier: number;
  hvac_kw: number;
  eco_speed_kmh: number;
  limit_speed_kmh: number;
  eco_energy_kwh: number;
  limit_energy_kwh: number;
  eco_time_min?: number;
};

type RouteSegment = {
  idx: number;
  distance_km: number;
  speed_limit: number;
  eco_speed: number;
  eco_energy: number;
  limit_energy: number;
  eco_time_min: number;
  limit_time_min: number;
  temp_c_avg: number;
  rain_mmh_avg: number;
};

type RouteApiResponse = {
  segments: RouteSegment[];
  route_coordinates: Array<[number, number]>;
  routeChargingStations: StationStop[];
  nearbyChargingStations?: ChargingStation[];
  battery_start_pct?: number;
  battery_end_pct?: number;
  total_distance_km: number;
  total_eco_energy: number;
  total_limit_energy: number;
  total_eco_time_min: number;
  total_limit_time_min: number;
  total_eco_drive_time_min?: number;
  total_limit_drive_time_min?: number;
  total_eco_charge_time_min?: number;
  total_limit_charge_time_min?: number;
  total_eco_cost_eur: number;
  total_limit_cost_eur: number;
  total_eco_trip_cost_all_in_eur?: number;
  total_limit_trip_cost_all_in_eur?: number;
  recharge_needed_eco_kwh: number;
  recharge_needed_limit_kwh: number;
  recharge_cost_eco_eur: number;
  recharge_cost_limit_eur: number;
  weather_avg_temp_c: number;
  weather_avg_rain_mmh: number;
  weather_avg_wind_kmh?: number;
  weather_temperature_min_c?: number;
  weather_temperature_max_c?: number;
  weather_impact_eco_kwh?: number;
  weather_impact_eco_eur?: number;
  elevation_gain_m?: number;
  elevation_loss_m?: number;
  co2_avoided_kg?: number;
  co2_equivalents?: { message?: string };
  warnings?: string[];
  weather_profile_edges?: WeatherEdge[];
  vehicle_profile?: Partial<VehicleProfile>;
};

type RecomputedStop = StationStop & {
  originalIndex: number;
  key: string;
  selected: boolean;
  computedBatteryLevelAtCharge: number;
  computedMinimumEnergyToCharge: number;
  computedMinimumTargetBatteryPct: number;
  computedMinimumChargingTimeMinutes: number;
  computedChosenTargetPct: number;
  computedChosenEnergyKwh: number;
  computedChosenChargingTimeMinutes: number;
  computedEstimatedChargeCostEur?: number;
  computedDriveTimeFromPreviousStopMin: number;
  computedDriveDistanceFromPreviousStopKm: number;
  unreachable: boolean;
  unreachableByKwh: number;
  cannotContinueAfterCharge: boolean;
  postChargeShortfallKwh: number;
};

type VehicleProfile = {
  empty_mass: number;
  drag_coefficient: number;
  frontal_area: number;
  rolling_resistance: number;
  motor_efficiency: number;
  regen_efficiency: number;
  aux_power_kw: number;
  battery_kwh: number;
  max_charge_kw: number;
};

type VehiclePreset = {
  id: string;
  label: string;
  blurb: Record<Locale, string>;
  profile: VehicleProfile;
};

type ActiveTripSession = {
  tripId: string;
  status: "planned" | "in_progress" | "paused" | "completed" | "abandoned";
  createdAtIso: string;
  start: string;
  end: string;
  route: RouteApiResponse;
  remainingCoords: [number, number][];
  remainingEcoSpeedsKmh: number[];
  segmentIndex: number;
  batteryPctBefore: number;
  batteryPctAfter: number;
  didRecharge: boolean;
  comfortTempC: number;
  vehicleProfile: VehicleProfile;
};

type CompletedTrip = {
  id: string;
  completedAtIso: string;
  start: string;
  end: string;
  distanceKm: number;
  energySavedKwh: number;
  savingsEur: number;
  co2SavedKg: number;
  driveTimeMin: number;
  chargingStops: number;
};

type Achievement = {
  id: string;
  title: Record<Locale, string>;
  description: Record<Locale, string>;
  earned: boolean;
};

const ACTIVE_TRIP_KEY = "ecospeed_active_trip_v2";
const COMPLETED_TRIPS_KEY = "ecospeed_completed_trips_v2";
const MIN_REALISTIC_CHARGE_STOP_MIN = 8;

const VEHICLE_PRESETS: VehiclePreset[] = [
  {
    id: "model-y",
    label: "Tesla Model Y",
    blurb: {
      fr: "SUV efficient avec recharge rapide haute puissance.",
      en: "Efficient SUV with strong fast-charging capability.",
    },
    profile: {
      empty_mass: 2000,
      drag_coefficient: 0.25,
      frontal_area: 2.3,
      rolling_resistance: 0.009,
      motor_efficiency: 0.95,
      regen_efficiency: 0.84,
      aux_power_kw: 1.6,
      battery_kwh: 75,
      max_charge_kw: 250,
    },
  },
  {
    id: "model-3",
    label: "Tesla Model 3 LR",
    blurb: {
      fr: "Berline efficiente avec excellente aerodynamique.",
      en: "Efficient sedan with excellent aerodynamics.",
    },
    profile: {
      empty_mass: 1820,
      drag_coefficient: 0.23,
      frontal_area: 2.22,
      rolling_resistance: 0.009,
      motor_efficiency: 0.95,
      regen_efficiency: 0.85,
      aux_power_kw: 1.5,
      battery_kwh: 75,
      max_charge_kw: 250,
    },
  },
  {
    id: "megane-e",
    label: "Renault Megane E-Tech",
    blurb: {
      fr: "Compacte efficiente, batterie plus compacte, recharge intermediaire.",
      en: "Efficient compact EV with a smaller battery and mid-range charging speed.",
    },
    profile: {
      empty_mass: 1624,
      drag_coefficient: 0.29,
      frontal_area: 2.35,
      rolling_resistance: 0.01,
      motor_efficiency: 0.93,
      regen_efficiency: 0.8,
      aux_power_kw: 1.5,
      battery_kwh: 60,
      max_charge_kw: 130,
    },
  },
  {
    id: "id4",
    label: "Volkswagen ID.4",
    blurb: {
      fr: "Gabarit familial avec surface frontale plus importante.",
      en: "Family-sized vehicle with a larger frontal area.",
    },
    profile: {
      empty_mass: 2124,
      drag_coefficient: 0.29,
      frontal_area: 2.42,
      rolling_resistance: 0.01,
      motor_efficiency: 0.92,
      regen_efficiency: 0.79,
      aux_power_kw: 1.7,
      battery_kwh: 77,
      max_charge_kw: 135,
    },
  },
  {
    id: "ioniq-5",
    label: "Hyundai Ioniq 5",
    blurb: {
      fr: "Recharge tres rapide et bon compromis familial.",
      en: "Very fast charging and a strong family-size balance.",
    },
    profile: {
      empty_mass: 2020,
      drag_coefficient: 0.29,
      frontal_area: 2.36,
      rolling_resistance: 0.0095,
      motor_efficiency: 0.93,
      regen_efficiency: 0.82,
      aux_power_kw: 1.7,
      battery_kwh: 77.4,
      max_charge_kw: 220,
    },
  },
  {
    id: "ev6",
    label: "Kia EV6",
    blurb: {
      fr: "Crossover efficient avec architecture 800 V.",
      en: "Efficient crossover with 800 V fast charging.",
    },
    profile: {
      empty_mass: 1985,
      drag_coefficient: 0.28,
      frontal_area: 2.34,
      rolling_resistance: 0.0095,
      motor_efficiency: 0.93,
      regen_efficiency: 0.82,
      aux_power_kw: 1.7,
      battery_kwh: 77.4,
      max_charge_kw: 235,
    },
  },
  {
    id: "scenic-e",
    label: "Renault Scenic E-Tech",
    blurb: {
      fr: "Familiale recente avec batterie 87 kWh.",
      en: "New family EV with an 87 kWh battery.",
    },
    profile: {
      empty_mass: 1890,
      drag_coefficient: 0.28,
      frontal_area: 2.38,
      rolling_resistance: 0.0098,
      motor_efficiency: 0.93,
      regen_efficiency: 0.8,
      aux_power_kw: 1.6,
      battery_kwh: 87,
      max_charge_kw: 150,
    },
  },
  {
    id: "e-208",
    label: "Peugeot e-208",
    blurb: {
      fr: "Citadine plus legere avec batterie compacte.",
      en: "Lighter city car with a compact battery.",
    },
    profile: {
      empty_mass: 1520,
      drag_coefficient: 0.31,
      frontal_area: 1.9,
      rolling_resistance: 0.009,
      motor_efficiency: 0.92,
      regen_efficiency: 0.77,
      aux_power_kw: 1.4,
      battery_kwh: 50,
      max_charge_kw: 100,
    },
  },
  {
    id: "bmw-i4",
    label: "BMW i4 eDrive40",
    blurb: {
      fr: "Grande autonomie et profil plus routier.",
      en: "Long range and a more motorway-focused profile.",
    },
    profile: {
      empty_mass: 2050,
      drag_coefficient: 0.24,
      frontal_area: 2.29,
      rolling_resistance: 0.0092,
      motor_efficiency: 0.94,
      regen_efficiency: 0.83,
      aux_power_kw: 1.6,
      battery_kwh: 81.3,
      max_charge_kw: 205,
    },
  },
];

const panelCopy = {
  fr: {
    sectionLabel: "Nouveau trajet",
    sectionTitle: "Calculer, comprendre et suivre un trajet VE sans surcharge.",
    sectionIntro:
      "L interface met en avant les informations les plus utiles, avec une lecture rapide pour l utilisateur et un mode de suivi plus simple pendant la conduite.",
    start: "Depart",
    end: "Arrivee",
    batteryStart: "Batterie depart",
    batteryEnd: "Batterie arrivee",
    batteryStartHint: "Pourcentage au depart",
    batteryEndHint: "Reserve souhaitee a l arrivee",
    passengers: "Passagers",
    weight: "Poids moyen / passager",
    comfort: "Temperature de confort",
    comfortHint: "Utilisee pour le modele HVAC",
    vehicle: "Profil vehicule",
    custom: "Personnalise",
    mass: "Masse a vide",
    aero: "Coefficient aero",
    area: "Surface frontale",
    battery: "Batterie utile",
    calculate: "Calculer le trajet optimise",
    calculating: "Calcul en cours...",
    resetSession: "Reinitialiser la session",
    stateTitle: "Etat du trajet",
    statePaused: "Session en pause dans ce navigateur.",
    stateProgress: "Trajet relance avec dernier etat connu.",
    stateReady: "Trajet calcule et pret a etre suivi.",
    createdOn: "Cree le",
    segment: "Segment",
    resultsMenu: "Navigation",
    tabEssentials: "Essentiel",
    tabCharging: "Recharge & carte",
    tabAnalysis: "Analyse detaillee",
    tabTrip: "Suivi & historique",
    summary: "Resume",
    summaryTitle: "Ce que l utilisateur doit voir d abord",
    summaryIntro:
      "La vue resume ne garde que les informations decisives: gains, vitesse recommandee, charge suivante et comparaison simple.",
    estimatedSavings: "Economies estimees",
    energySaved: "Energie economisee",
    timeEco: "Temps eco",
    timeLimit: "Temps limite",
    rechargeEco: "Recharge eco",
    averageWind: "Vent moyen",
    rangeRecovered: "Autonomie recuperee",
    fastChargeEquivalent: "Equivalent charge rapide",
    quickDrive: "Lecture conduite",
    quickDriveTitle: "Le minimum a regarder pendant le trajet",
    targetSpeed: "Vitesse conseillee maintenant",
    currentSection: "Portion en cours",
    nextCharge: "Prochaine recharge",
    arrivalTarget: "Reserve a l arrivee",
    noChargeNeeded: "Aucune recharge prevue",
    gainsTitle: "Ce que tu gagnes concretement",
    gainsIntro: "Le benefice de la vitesse optimale, en langage simple",
    homeCharge: "Soit l equivalent d environ",
    homeChargeSuffix: "h de charge a la maison.",
    couldBeUsed: "Cette energie pourrait servir a rouler a nouveau sur un trajet quotidien.",
    lessThanTrip: "de moins que le meme trajet roule a la limite.",
    comparison: "Comparatif",
    distance: "Distance",
    fullEcoCost: "Cout eco complet",
    fullLimitCost: "Cout limite complet",
    optimizedCharges: "Recharges optimisees",
    map: "Carte du trajet",
    mapTitle: "Trace, arrets de charge et bornes proches",
    mapText: "Le trajet optimise est affiche avec les arrets proposes et les bornes proches du corridor.",
    routeLegend: "Trajet optimise",
    stopLegend: "Arret de charge",
    nearbyLegend: "Borne a proximite",
    weather: "Meteo & energie",
    weatherTitle: "Lecture rapide des conditions sur le parcours",
    weatherImpact: "impact meteo",
    co2Equivalent: "Equivalent CO2",
    tripManagement: "Gestion du trajet",
    tripManagementTitle: "Mettre en pause, reprendre et terminer",
    currentSegment: "Segment courant",
    batteryBeforeStop: "Batterie avant arret",
    batteryAfterStop: "Batterie apres arret",
    rechargeDone: "Recharge effectuee",
    yes: "Oui",
    no: "Non",
    pause: "Mettre en pause",
    resume: "Reprendre",
    finish: "Terminer le trajet",
    chargePlan: "Plan de charge",
    chargePlanTitle: "Arrets strictement utiles pour continuer le trajet",
    chargePlanText:
      "Chaque pause affiche le minimum de recharge pour repartir, puis vous pouvez simuler un pourcentage plus haut si vous voulez rester plus longtemps a la borne.",
    rechargeHere: "Recharger ici",
    chargeSelectionHint: "Choisissez les arrets ou vous voulez vraiment recharger.",
    atLeastOneStop: "Selectionnez au moins un arret de recharge.",
    recalculatedStop: "Recalcule selon les arrets conserves",
    unreachableStop: "Cet arret n est plus atteignable avec la selection actuelle.",
    noStopNeeded: "Aucun arret n est necessaire pour ce trajet.",
    costEstimated: "estime",
    costIncluded: "Cout borne estime dans le total",
    detour: "detour",
    chargeAfterDriving: "Pause apres conduite",
    chargeMinimum: "Minimum pour repartir",
    chargeMinimumTime: "Temps mini",
    chargeChosenTarget: "Recharge souhaitee",
    chargeChosenTime: "Temps pour cette cible",
    chargeChosenEnergy: "Energie pour cette cible",
    chargeTargetHint: "Doit rester au-dessus du minimum calcule",
    strategicPause: "Pause proche de la fenetre des 2 h",
    chargingStationSegment: "sur le segment",
    nearbyStations: "Bornes a proximite",
    history: "Historique reel",
    historyTitle: "Trajets termines localement",
    historyText:
      "Les simulations ne polluent plus l historique principal. Seuls les trajets marques comme termines apparaissent ici.",
    historyEmpty: "Aucun trajet reel n a encore ete termine sur ce navigateur.",
    achievements: "Badges",
    achievementsTitle: "Des paliers simples pour donner envie de revenir",
    achievementsText: "Les badges se debloquent automatiquement selon les trajets calcules et termines.",
    unlocked: "Debloque",
    locked: "A debloquer",
    segmentBreakdown: "Decoupage du trajet",
    segmentBreakdownTitle: "Segment par segment, avec la vitesse eco calculee physiquement",
    segmentBreakdownText:
      "Chaque segment reprend la vitesse optimale retenue par le modele, la vitesse limite de reference, l energie consommee et le gain associe.",
    segmentsAnalysed: "segments analyses",
    gainedOverall: "gagnes sur l ensemble",
    limit: "Limite",
    gain: "Gain",
    weatherLabel: "Meteo",
    nextStopIn: "prochain stop",
    motorwayGuardrail:
      "Sur autoroute, la recommandation reste volontairement au-dessus de 100 km/h en conditions normales pour rester lisible et confortable dans le flux.",
  },
  en: {
    sectionLabel: "New trip",
    sectionTitle: "Calculate, understand and follow an EV trip without overload.",
    sectionIntro:
      "The interface prioritizes the most useful information, with a quick-glance layout for users and a simpler view while driving.",
    start: "Start",
    end: "Destination",
    batteryStart: "Start battery",
    batteryEnd: "Arrival battery",
    batteryStartHint: "State of charge at departure",
    batteryEndHint: "Target reserve on arrival",
    passengers: "Passengers",
    weight: "Average weight / passenger",
    comfort: "Comfort temperature",
    comfortHint: "Used by the HVAC model",
    vehicle: "Vehicle profile",
    custom: "Custom",
    mass: "Curb mass",
    aero: "Drag coefficient",
    area: "Frontal area",
    battery: "Battery capacity",
    calculate: "Calculate optimized trip",
    calculating: "Calculating...",
    resetSession: "Reset session",
    stateTitle: "Trip status",
    statePaused: "Session paused in this browser.",
    stateProgress: "Trip resumed with the latest known state.",
    stateReady: "Trip calculated and ready to follow.",
    createdOn: "Created on",
    segment: "Segment",
    resultsMenu: "Navigation",
    tabEssentials: "Essentials",
    tabCharging: "Charging & map",
    tabAnalysis: "Detailed analysis",
    tabTrip: "Trip & history",
    summary: "Summary",
    summaryTitle: "What the user should see first",
    summaryIntro:
      "The summary keeps only the most important information: gains, recommended speed, next charge and a simple comparison.",
    estimatedSavings: "Estimated savings",
    energySaved: "Energy saved",
    timeEco: "Eco time",
    timeLimit: "Speed-limit time",
    rechargeEco: "Eco charging",
    averageWind: "Average wind",
    rangeRecovered: "Recovered range",
    fastChargeEquivalent: "Fast-charge equivalent",
    quickDrive: "Drive view",
    quickDriveTitle: "The minimum you need to see while driving",
    targetSpeed: "Recommended speed now",
    currentSection: "Current section",
    nextCharge: "Next charge",
    arrivalTarget: "Arrival reserve",
    noChargeNeeded: "No charging stop planned",
    gainsTitle: "What the optimized speed really saves",
    gainsIntro: "Concrete benefits explained in simple language",
    homeCharge: "That is about",
    homeChargeSuffix: "hours of home charging.",
    couldBeUsed: "That saved energy can be used again on a daily trip.",
    lessThanTrip: "less than the same trip driven at the speed limit.",
    comparison: "Comparison",
    distance: "Distance",
    fullEcoCost: "Full eco cost",
    fullLimitCost: "Full speed-limit cost",
    optimizedCharges: "Optimized charges",
    map: "Trip map",
    mapTitle: "Route, charging stops and nearby chargers",
    mapText: "The optimized trip is shown with suggested charging stops and nearby corridor chargers.",
    routeLegend: "Optimized route",
    stopLegend: "Charging stop",
    nearbyLegend: "Nearby charger",
    weather: "Weather & energy",
    weatherTitle: "Quick reading of conditions along the route",
    weatherImpact: "weather impact",
    co2Equivalent: "CO2 equivalent",
    tripManagement: "Trip management",
    tripManagementTitle: "Pause, resume and complete the trip",
    currentSegment: "Current segment",
    batteryBeforeStop: "Battery before stop",
    batteryAfterStop: "Battery after stop",
    rechargeDone: "Charge completed",
    yes: "Yes",
    no: "No",
    pause: "Pause",
    resume: "Resume",
    finish: "Complete trip",
    chargePlan: "Charging plan",
    chargePlanTitle: "Only the charging stops that are needed to continue",
    chargePlanText:
      "Each stop shows the minimum charge needed to continue, then lets the user simulate a higher target state of charge.",
    rechargeHere: "Charge here",
    chargeSelectionHint: "Choose the stops where you actually want to charge.",
    atLeastOneStop: "Select at least one charging stop.",
    recalculatedStop: "Recalculated from the kept stops",
    unreachableStop: "This stop can no longer be reached with the current selection.",
    noStopNeeded: "No stop is required for this trip.",
    costEstimated: "estimated",
    costIncluded: "Charging cost already included in the total",
    detour: "detour",
    chargeAfterDriving: "Break after driving",
    chargeMinimum: "Minimum to continue",
    chargeMinimumTime: "Minimum time",
    chargeChosenTarget: "Desired charge target",
    chargeChosenTime: "Time for this target",
    chargeChosenEnergy: "Energy for this target",
    chargeTargetHint: "Must stay above the calculated minimum",
    strategicPause: "Close to the 2-hour break window",
    chargingStationSegment: "on segment",
    nearbyStations: "Nearby chargers",
    history: "Real history",
    historyTitle: "Trips completed locally",
    historyText:
      "Simulations no longer pollute the main history. Only trips marked as completed appear here.",
    historyEmpty: "No real trip has been completed in this browser yet.",
    achievements: "Badges",
    achievementsTitle: "Simple milestones that encourage users to come back",
    achievementsText: "Badges unlock automatically based on calculated and completed trips.",
    unlocked: "Unlocked",
    locked: "Locked",
    segmentBreakdown: "Trip breakdown",
    segmentBreakdownTitle: "Segment by segment, with the physics-based eco speed",
    segmentBreakdownText:
      "Each segment shows the chosen optimal speed, the reference speed limit, the consumed energy and the resulting gain.",
    segmentsAnalysed: "segments analysed",
    gainedOverall: "saved overall",
    limit: "Limit",
    gain: "Gain",
    weatherLabel: "Weather",
    nextStopIn: "next stop",
    motorwayGuardrail:
      "On motorways, the recommendation now stays above 100 km/h in normal conditions so the advice remains easier to follow within traffic.",
  },
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(minutes?: number) {
  const safe = Math.max(0, Number(minutes ?? 0));
  const h = Math.floor(safe / 60);
  const m = Math.round(safe % 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}min` : `${m} min`;
}

function formatMoney(value?: number) {
  return `${Number(value ?? 0).toFixed(2)} EUR`;
}

function formatDate(iso: string, locale: Locale) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCo2(kg: number, locale: Locale) {
  const bikes = Math.round(kg / 0.021);
  const phones = Math.round(kg / 0.00822);
  return locale === "fr"
    ? `${kg.toFixed(2)} kg CO2, soit env. ${bikes} km a velo ou ${phones} charges smartphone`
    : `${kg.toFixed(2)} kg CO2, around ${bikes} km by bike or ${phones} smartphone charges`;
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function estimateChargingMinutesForTarget(
  currentPct: number,
  targetPct: number,
  batteryKwh: number,
  vehicleMaxChargeKw: number,
  stationPowerKw: number,
) {
  return estimateChargingMinutesFromSoc(currentPct, targetPct, batteryKwh, vehicleMaxChargeKw, stationPowerKw);
}

function buildStopKey(stop: StationStop, index: number) {
  return `${stop.station.name}-${stop.segmentIndex}-${index}`;
}

function estimateStationPriceEurPerKwh(station: ChargingStation) {
  const raw = String(station.price ?? "").replace(",", ".").replace(/[â‚¬$]/g, "");
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(?:eur)?\s*\/\s*kwh/i);
  if (match) return Math.max(0, Number(match[1]));
  const powerKw = Number(station.powerKw ?? 0);
  if (powerKw >= 300) return 0.69;
  if (powerKw >= 200) return 0.62;
  if (powerKw >= 150) return 0.56;
  if (powerKw >= 100) return 0.49;
  if (powerKw >= 50) return 0.43;
  return 0.35;
}

function haversineKm(a: [number, number], b: [number, number]) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestCoordIndexOnPath(point: [number, number], path: Array<[number, number]>) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < path.length; index += 1) {
    const distance = haversineKm(point, path[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function buildAchievements(
  locale: Locale,
  completedTrips: CompletedTrip[],
  currentRoute: RouteApiResponse | null,
  energySavedKwh: number,
  co2SavedKg: number,
): Achievement[] {
  const completedCount = completedTrips.length;
  const bestEnergySaved = Math.max(energySavedKwh, ...completedTrips.map((trip) => Number(trip.energySavedKwh ?? 0)), 0);
  const bestCo2Saved = Math.max(co2SavedKg, ...completedTrips.map((trip) => Number(trip.co2SavedKg ?? 0)), 0);
  const noChargeTrip =
    (currentRoute?.routeChargingStations.length ?? 1) === 0 || completedTrips.some((trip) => Number(trip.chargingStops ?? 0) === 0);
  const rainyTrip = Number(currentRoute?.weather_avg_rain_mmh ?? 0) > 0.05;

  const badges: Achievement[] = [
    {
      id: "first-route",
      title: { fr: "Premier calcul", en: "First calculation" },
      description: {
        fr: "Lancer un premier trajet optimise.",
        en: "Run your first optimized trip.",
      },
      earned: Boolean(currentRoute) || completedCount > 0,
    },
    {
      id: "first-finish",
      title: { fr: "Trajet termine", en: "Trip completed" },
      description: {
        fr: "Terminer un vrai trajet dans l application.",
        en: "Complete a real trip in the app.",
      },
      earned: completedCount >= 1,
    },
    {
      id: "eco-10",
      title: { fr: "Eco 10 kWh", en: "10 kWh saver" },
      description: {
        fr: "Economiser au moins 10 kWh sur un trajet.",
        en: "Save at least 10 kWh on one trip.",
      },
      earned: bestEnergySaved >= 10,
    },
    {
      id: "co2-guardian",
      title: { fr: "Gardien CO2", en: "CO2 guardian" },
      description: {
        fr: "Eviter au moins 2 kg de CO2 sur un trajet.",
        en: "Avoid at least 2 kg of CO2 on a trip.",
      },
      earned: bestCo2Saved >= 2,
    },
    {
      id: "smooth-driver",
      title: { fr: "Trajet sans recharge", en: "No-charge trip" },
      description: {
        fr: "Finir un trajet sans aucun arret recharge.",
        en: "Finish a trip without any charging stop.",
      },
      earned: noChargeTrip,
    },
    {
      id: "regular",
      title: { fr: "Habitude verte", en: "Green habit" },
      description: {
        fr: "Terminer 3 trajets dans l historique.",
        en: "Complete 3 trips in history.",
      },
      earned: completedCount >= 3,
    },
    {
      id: "rain-aware",
      title: { fr: "Sous la pluie", en: "Rain aware" },
      description: {
        fr: "Calculer un trajet avec pluie detectee.",
        en: "Calculate a trip with detected rain.",
      },
      earned: rainyTrip,
    },
  ];

  void locale;
  return badges;
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function validateRouteInputs(locale: Locale, start: string, end: string, batteryStart: number, batteryEnd: number) {
  if (!start.trim() || !end.trim()) return locale === "fr" ? "Renseigne un depart et une arrivee." : "Please enter a start and a destination.";
  if (start.trim().toLowerCase() === end.trim().toLowerCase()) {
    return locale === "fr" ? "Le depart et l arrivee doivent etre differents." : "Start and destination must be different.";
  }
  if (batteryStart <= batteryEnd) {
    return locale === "fr"
      ? "La batterie de depart doit etre superieure a la batterie d arrivee."
      : "Start battery must be higher than arrival battery.";
  }
  if (batteryStart < 5 || batteryStart > 100) {
    return locale === "fr"
      ? "La batterie de depart doit rester entre 5 et 100%."
      : "Start battery must stay between 5% and 100%.";
  }
  if (batteryEnd < 5 || batteryEnd > 90) {
    return locale === "fr"
      ? "La batterie d arrivee doit rester entre 5 et 90%."
      : "Arrival battery must stay between 5% and 90%.";
  }
  return "";
}

function buildCompletedTrip(route: RouteApiResponse, start: string, end: string): CompletedTrip {
  const limitTotal = Number(route.total_limit_trip_cost_all_in_eur ?? route.total_limit_cost_eur + route.recharge_cost_limit_eur);
  const ecoTotal = Number(route.total_eco_trip_cost_all_in_eur ?? route.total_eco_cost_eur + route.recharge_cost_eco_eur);
  return {
    id: `done-${Date.now()}`,
    completedAtIso: new Date().toISOString(),
    start,
    end,
    distanceKm: Number(route.total_distance_km ?? 0),
    energySavedKwh: Math.max(0, Number(route.total_limit_energy ?? 0) - Number(route.total_eco_energy ?? 0)),
    savingsEur: Math.max(0, limitTotal - ecoTotal),
    co2SavedKg: Math.max(0, Number(route.co2_avoided_kg ?? 0)),
    driveTimeMin: Number(route.total_eco_time_min ?? 0),
    chargingStops: Array.isArray(route.routeChargingStations) ? route.routeChargingStations.length : 0,
  };
}

export default function LaunchControlPanel({ locale }: { locale: Locale }) {
  const t = panelCopy[locale];
  const [start, setStart] = useState("Paris");
  const [end, setEnd] = useState("Lyon");
  const [batteryStart, setBatteryStart] = useState(80);
  const [batteryEnd, setBatteryEnd] = useState(20);
  const [numPassengers, setNumPassengers] = useState(1);
  const [avgWeightKg, setAvgWeightKg] = useState(75);
  const [comfortTempC, setComfortTempC] = useState(20);
  const [vehiclePresetId, setVehiclePresetId] = useState("model-y");
  const [customVehicle, setCustomVehicle] = useState<VehicleProfile>(VEHICLE_PRESETS[0].profile);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<RouteApiResponse | null>(null);
  const [activeTrip, setActiveTrip] = useState<ActiveTripSession | null>(null);
  const [completedTrips, setCompletedTrips] = useState<CompletedTrip[]>([]);
  const [stopSegment, setStopSegment] = useState(1);
  const [batteryBefore, setBatteryBefore] = useState(35);
  const [didRecharge, setDidRecharge] = useState(true);
  const [batteryAfter, setBatteryAfter] = useState(72);
  const [pauseMsg, setPauseMsg] = useState("");
  const [resumeMsg, setResumeMsg] = useState("");
  const [chargeTargetsByStop, setChargeTargetsByStop] = useState<Record<string, number>>({});
  const [selectedStopsByKey, setSelectedStopsByKey] = useState<Record<string, boolean>>({});
  const [chargeSelectionError, setChargeSelectionError] = useState("");
  const [activeResultsTab, setActiveResultsTab] = useState<ResultsTab>("essentials");

  useEffect(() => {
    const storedTrip = readJson<ActiveTripSession | null>(ACTIVE_TRIP_KEY, null);
    const storedHistory = readJson<CompletedTrip[]>(COMPLETED_TRIPS_KEY, []);
    setCompletedTrips(storedHistory);
    if (storedTrip) {
      setActiveTrip(storedTrip);
      setRoute(storedTrip.route);
      setStart(storedTrip.start);
      setEnd(storedTrip.end);
      setComfortTempC(storedTrip.comfortTempC);
      setCustomVehicle(storedTrip.vehicleProfile);
      setVehiclePresetId("custom");
      setStopSegment(storedTrip.segmentIndex);
      setBatteryBefore(storedTrip.batteryPctBefore);
      setBatteryAfter(storedTrip.batteryPctAfter);
      setDidRecharge(storedTrip.didRecharge);
    }
  }, []);

  useEffect(() => {
    if (!route) {
      setChargeTargetsByStop({});
      setSelectedStopsByKey({});
      setChargeSelectionError("");
      return;
    }
    const defaults = route.routeChargingStations.reduce<Record<string, number>>((acc, stop, index) => {
      const minTarget = Math.ceil(stop.minimumTargetBatteryPct ?? stop.batteryPctAfterCharge ?? stop.targetBatteryPct ?? 0);
      acc[buildStopKey(stop, index)] = clamp(minTarget, 0, 95);
      return acc;
    }, {});
    setChargeTargetsByStop(defaults);
    setSelectedStopsByKey(
      route.routeChargingStations.reduce<Record<string, boolean>>((acc, stop, index) => {
        acc[buildStopKey(stop, index)] = true;
        return acc;
      }, {}),
    );
    setChargeSelectionError("");
    setActiveResultsTab("essentials");
  }, [route]);

  const selectedPreset = useMemo(() => {
    return VEHICLE_PRESETS.find((preset) => preset.id === vehiclePresetId) ?? null;
  }, [vehiclePresetId]);

  useEffect(() => {
    if (selectedPreset) setCustomVehicle(selectedPreset.profile);
  }, [selectedPreset]);

  const effectiveVehicle = useMemo(() => {
    return vehiclePresetId === "custom" || !selectedPreset ? customVehicle : selectedPreset.profile;
  }, [customVehicle, selectedPreset, vehiclePresetId]);

  const totalTripCostEco = useMemo(() => {
    if (!route) return 0;
    return Number(route.total_eco_trip_cost_all_in_eur ?? route.total_eco_cost_eur + route.recharge_cost_eco_eur);
  }, [route]);

  const totalTripCostLimit = useMemo(() => {
    if (!route) return 0;
    return Number(route.total_limit_trip_cost_all_in_eur ?? route.total_limit_cost_eur + route.recharge_cost_limit_eur);
  }, [route]);

  const energySavedKwh = useMemo(() => {
    if (!route) return 0;
    return Math.max(0, Number(route.total_limit_energy ?? 0) - Number(route.total_eco_energy ?? 0));
  }, [route]);

  const savingsEur = useMemo(() => Math.max(0, totalTripCostLimit - totalTripCostEco), [totalTripCostEco, totalTripCostLimit]);

  const savingsPct = useMemo(() => {
    if (totalTripCostLimit <= 0) return 0;
    return (savingsEur / totalTripCostLimit) * 100;
  }, [savingsEur, totalTripCostLimit]);

  const weatherSamples = route?.weather_profile_edges ?? [];
  const routeStations = route?.nearbyChargingStations ?? [];
  const routeBatteryKwh = Number(route?.vehicle_profile?.battery_kwh ?? effectiveVehicle.battery_kwh);
  const routeMaxChargeKw = Number(route?.vehicle_profile?.max_charge_kw ?? effectiveVehicle.max_charge_kw);
  const selectedChargingPlan = useMemo<RecomputedStop[]>(() => {
    if (!route) return [];
    const startBatteryPctValue = Number(route.battery_start_pct ?? batteryStart);
    const endBatteryPctValue = Math.max(10, Number(route.battery_end_pct ?? batteryEnd));
    const finalReserveKwh = routeBatteryKwh * (endBatteryPctValue / 100);
    const arrivalBufferKwh = Math.max(0.8, routeBatteryKwh * 0.01);
    const maxChargeKwh = routeBatteryKwh * 0.95;
    const coords = route.route_coordinates ?? [];
    const edgeProfile = route.weather_profile_edges ?? [];
    const coordEnergyPrefix = new Array(Math.max(1, coords.length)).fill(0);
    const coordTimePrefix = new Array(Math.max(1, coords.length)).fill(0);
    const coordDistancePrefix = new Array(Math.max(1, coords.length)).fill(0);
    for (let edgeIndex = 0; edgeIndex < Math.max(0, coords.length - 1); edgeIndex += 1) {
      const edgeDistanceKm = Number(edgeProfile[edgeIndex]?.distance_km ?? haversineKm(coords[edgeIndex], coords[edgeIndex + 1]));
      const ecoSpeedKmh = Math.max(20, Number(edgeProfile[edgeIndex]?.eco_speed_kmh ?? 90));
      coordEnergyPrefix[edgeIndex + 1] =
        coordEnergyPrefix[edgeIndex] + Number(edgeProfile[edgeIndex]?.eco_energy_kwh ?? 0);
      coordTimePrefix[edgeIndex + 1] =
        coordTimePrefix[edgeIndex] + Number(edgeProfile[edgeIndex]?.eco_time_min ?? (edgeDistanceKm / ecoSpeedKmh) * 60);
      coordDistancePrefix[edgeIndex + 1] =
        coordDistancePrefix[edgeIndex] + edgeDistanceKm;
    }

    const allStops = route.routeChargingStations.map((stop, index) => ({
      ...stop,
      originalIndex: index,
      key: buildStopKey(stop, index),
      coordIndex: coords.length > 0 ? nearestCoordIndexOnPath([stop.station.latitude, stop.station.longitude], coords) : 0,
      selected: selectedStopsByKey[buildStopKey(stop, index)] !== false,
    })).sort((a, b) => a.coordIndex - b.coordIndex || a.originalIndex - b.originalIndex);
    const keptStops = allStops.filter((stop) => stop.selected);
    let previousCoordIndex = 0;
    let currentEnergyKwh = routeBatteryKwh * (startBatteryPctValue / 100);

    return keptStops.map((stop, keptIndex) => {
      const energyToStopKwh =
        coordEnergyPrefix[stop.coordIndex] - coordEnergyPrefix[previousCoordIndex];
      const driveTimeMin =
        coordTimePrefix[stop.coordIndex] - coordTimePrefix[previousCoordIndex];
      const driveDistanceKm =
        coordDistancePrefix[stop.coordIndex] - coordDistancePrefix[previousCoordIndex];
      const arrivalEnergyKwh = currentEnergyKwh - energyToStopKwh;
      const nextSelectedStop = keptStops[keptIndex + 1];
      const energyAfterStopKwh =
        nextSelectedStop
          ? coordEnergyPrefix[nextSelectedStop.coordIndex] - coordEnergyPrefix[stop.coordIndex]
          : Math.max(0, Number(coordEnergyPrefix[coordEnergyPrefix.length - 1] ?? 0) - coordEnergyPrefix[stop.coordIndex]);
      const requiredTargetEnergyKwh = nextSelectedStop
        ? Math.max(0, energyAfterStopKwh + arrivalBufferKwh)
        : Math.max(0, energyAfterStopKwh + finalReserveKwh);
      const minimumTargetEnergyKwh = Math.min(
        maxChargeKwh,
        requiredTargetEnergyKwh,
      );
      const minimumEnergyToChargeKwh = Math.max(0, minimumTargetEnergyKwh - Math.max(0, arrivalEnergyKwh));
      const minimumTargetBatteryPct = clamp((minimumTargetEnergyKwh / routeBatteryKwh) * 100, 0, 95);
      const chosenTargetPct = clamp(
        Number(chargeTargetsByStop[stop.key] ?? Math.ceil(minimumTargetBatteryPct)),
        Math.ceil(minimumTargetBatteryPct),
        95,
      );
      const chosenTargetEnergyKwh = routeBatteryKwh * (chosenTargetPct / 100);
      const chosenEnergyKwh = Math.max(0, chosenTargetEnergyKwh - Math.max(0, arrivalEnergyKwh));
      const minimumChargingTimeMinutes =
        minimumEnergyToChargeKwh > 0
          ? Math.max(
              MIN_REALISTIC_CHARGE_STOP_MIN,
              estimateChargingMinutesForTarget(
                clamp((Math.max(0, arrivalEnergyKwh) / routeBatteryKwh) * 100, 0, 100),
                minimumTargetBatteryPct,
                routeBatteryKwh,
                routeMaxChargeKw,
                Number(stop.station.powerKw ?? routeMaxChargeKw),
              ),
            )
          : 0;
      const chosenChargingTimeMinutes =
        chosenEnergyKwh > 0
          ? Math.max(
              MIN_REALISTIC_CHARGE_STOP_MIN,
              estimateChargingMinutesForTarget(
                clamp((Math.max(0, arrivalEnergyKwh) / routeBatteryKwh) * 100, 0, 100),
                chosenTargetPct,
                routeBatteryKwh,
                routeMaxChargeKw,
                Number(stop.station.powerKw ?? routeMaxChargeKw),
              ),
            )
          : 0;
      const estimatedStationCost =
        chosenEnergyKwh > 0
          ? chosenEnergyKwh * estimateStationPriceEurPerKwh(stop.station)
          : 0;

      currentEnergyKwh = Math.max(0, arrivalEnergyKwh) + chosenEnergyKwh;
      previousCoordIndex = stop.coordIndex;

      return {
        ...stop,
        computedBatteryLevelAtCharge: clamp((arrivalEnergyKwh / routeBatteryKwh) * 100, -100, 100),
        computedMinimumEnergyToCharge: minimumEnergyToChargeKwh,
        computedMinimumTargetBatteryPct: minimumTargetBatteryPct,
        computedMinimumChargingTimeMinutes: minimumChargingTimeMinutes,
        computedChosenTargetPct: chosenTargetPct,
        computedChosenEnergyKwh: chosenEnergyKwh,
        computedChosenChargingTimeMinutes: chosenChargingTimeMinutes,
        computedEstimatedChargeCostEur: estimatedStationCost,
        computedDriveTimeFromPreviousStopMin: driveTimeMin,
        computedDriveDistanceFromPreviousStopKm: driveDistanceKm,
        unreachable: arrivalEnergyKwh < 0 || requiredTargetEnergyKwh > maxChargeKwh + 1e-6,
        unreachableByKwh: Math.max(0, -arrivalEnergyKwh),
        cannotContinueAfterCharge: requiredTargetEnergyKwh > maxChargeKwh + 1e-6,
        postChargeShortfallKwh: Math.max(0, requiredTargetEnergyKwh - maxChargeKwh),
      };
    });
  }, [batteryEnd, batteryStart, chargeTargetsByStop, route, routeBatteryKwh, routeMaxChargeKw, selectedStopsByKey]);
  const selectedChargingCount = selectedChargingPlan.length;
  const selectedChargingPlanByKey = useMemo(
    () => new Map(selectedChargingPlan.map((stop) => [stop.key, stop])),
    [selectedChargingPlan],
  );
  const co2SavedKg = Math.max(0, Number(route?.co2_avoided_kg ?? 0));
  const ecoConsumptionKwhPer100 = route && route.total_distance_km > 0 ? (route.total_eco_energy / route.total_distance_km) * 100 : 0;
  const autonomyRecoveredKm = ecoConsumptionKwhPer100 > 0 ? (energySavedKwh / ecoConsumptionKwhPer100) * 100 : 0;
  const homeChargeHoursSaved = energySavedKwh / 7.4;
  const chargingSessionsSaved = energySavedKwh / 50;
  const segmentEnergySavedKwh = route?.segments.reduce((sum, segment) => sum + Math.max(0, segment.limit_energy - segment.eco_energy), 0) ?? 0;
  const achievements = useMemo(
    () => buildAchievements(locale, completedTrips, route, energySavedKwh, co2SavedKg),
    [co2SavedKg, completedTrips, energySavedKwh, locale, route],
  );
  const currentDriveSegment = route
    ? route.segments[Math.max(0, Math.min(route.segments.length - 1, stopSegment - 1))]
    : null;
  const nextChargingStop = selectedChargingPlan.find((stop) => stop.segmentIndex >= Math.max(1, stopSegment)) ?? null;
  const resultTabs: Array<{ id: ResultsTab; label: string }> = [
    { id: "essentials", label: t.tabEssentials },
    { id: "charging", label: t.tabCharging },
    { id: "analysis", label: t.tabAnalysis },
    { id: "trip", label: t.tabTrip },
  ];
  const showEssentials = activeResultsTab === "essentials";
  const showCharging = activeResultsTab === "charging";
  const showAnalysis = activeResultsTab === "analysis";
  const showTrip = activeResultsTab === "trip";
  const showMotorwayGuardrail = Number(currentDriveSegment?.speed_limit ?? 0) >= 110;

  const persistActiveTrip = (trip: ActiveTripSession | null) => {
    if (trip) {
      writeJson(ACTIVE_TRIP_KEY, trip);
    } else {
      window.localStorage.removeItem(ACTIVE_TRIP_KEY);
    }
    setActiveTrip(trip);
  };

  const toggleChargingStop = (stopKey: string, checked: boolean) => {
    setSelectedStopsByKey((current) => {
      const next = { ...current, [stopKey]: checked };
      const activeCount = Object.values(next).filter(Boolean).length;
      if (activeCount === 0) {
        setChargeSelectionError(t.atLeastOneStop);
        return current;
      }
      setChargeSelectionError("");
      return next;
    });
  };

  const submitRoute = async (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateRouteInputs(locale, start, end, batteryStart, batteryEnd);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError("");
    setPauseMsg("");
    setResumeMsg("");

    try {
      const payload = {
        start,
        end,
        battery_start_pct: batteryStart,
        battery_end_pct: batteryEnd,
        num_passengers: Math.max(0, Number(numPassengers)),
        avg_weight_kg: Math.max(0, Number(avgWeightKg)),
        use_climate: true,
        climate_intensity: 55,
        comfort_temp_c: comfortTempC,
        vehicle_profile: effectiveVehicle,
      };

      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as RouteApiResponse & { detail?: string };
      if (!response.ok) throw new Error(data.detail || (locale === "fr" ? "Le calcul du trajet a echoue." : "Trip calculation failed."));

      setRoute(data);
      setStopSegment(1);
      setBatteryBefore(Math.max(batteryEnd, 20));
      setBatteryAfter(
        Math.min(
          95,
          Math.max(
            Math.ceil(data.routeChargingStations[0]?.minimumTargetBatteryPct ?? data.routeChargingStations[0]?.batteryPctAfterCharge ?? 0),
            batteryEnd,
          ),
        ),
      );

      const nextTrip: ActiveTripSession = {
        tripId: `trip-${Date.now()}`,
        status: "planned",
        createdAtIso: new Date().toISOString(),
        start,
        end,
        route: data,
        remainingCoords: data.route_coordinates.map(([lat, lon]) => [lon, lat] as [number, number]),
        remainingEcoSpeedsKmh: (data.weather_profile_edges ?? []).map((item) => Number(item.eco_speed_kmh ?? 90)),
        segmentIndex: 1,
        batteryPctBefore: batteryStart,
        batteryPctAfter: batteryStart,
        didRecharge: false,
        comfortTempC,
        vehicleProfile: effectiveVehicle,
      };
      persistActiveTrip(nextTrip);
    } catch (err) {
      setError(err instanceof Error ? err.message : locale === "fr" ? "Erreur de calcul." : "Calculation error.");
      setRoute(null);
    } finally {
      setLoading(false);
    }
  };

  const pauseTrip = async () => {
    if (!route || !activeTrip) return;
    const segment = clamp(stopSegment, 1, Math.max(1, route.segments.length));
    const pointIdx = clamp(segment, 0, Math.max(0, route.route_coordinates.length - 1));
    const remainingCoords = route.route_coordinates.slice(pointIdx).map(([lat, lon]) => [lon, lat] as [number, number]);
    const remainingEcoSpeedsKmh = (route.weather_profile_edges ?? [])
      .slice(pointIdx)
      .map((item) => Math.max(20, Number(item.eco_speed_kmh ?? 90)));

    const nextTrip: ActiveTripSession = {
      ...activeTrip,
      status: "paused",
      route,
      remainingCoords,
      remainingEcoSpeedsKmh,
      segmentIndex: segment,
      batteryPctBefore: clamp(batteryBefore, 0, 100),
      batteryPctAfter: didRecharge ? clamp(batteryAfter, 0, 100) : clamp(batteryBefore, 0, 100),
      didRecharge,
      comfortTempC,
      vehicleProfile: effectiveVehicle,
    };

    persistActiveTrip(nextTrip);

    try {
      await fetch("/api/trip/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: nextTrip.tripId,
          segmentIndex: nextTrip.segmentIndex,
          batteryPctBefore: nextTrip.batteryPctBefore,
          didRecharge: nextTrip.didRecharge,
          batteryPctAfter: nextTrip.batteryPctAfter,
          remainingCoords: nextTrip.remainingCoords,
          remainingEcoSpeedsKmh: nextTrip.remainingEcoSpeedsKmh,
          comfortTempC: nextTrip.comfortTempC,
          vehicleProfile: nextTrip.vehicleProfile,
          distanceKm: route.total_distance_km,
        }),
      });
    } catch {}

    setPauseMsg(
      locale === "fr"
        ? `Trajet en pause au segment ${segment}. La session est sauvegardee dans ce navigateur.`
        : `Trip paused at segment ${segment}. The session is saved in this browser.`,
    );
    setResumeMsg("");
  };

  const resumeTrip = async () => {
    if (!activeTrip) return;
    setResumeMsg("");
    try {
      const response = await fetch("/api/trip/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: activeTrip.tripId,
          batteryPctAfter: activeTrip.batteryPctAfter,
          sessionSnapshot: activeTrip,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        recalculated_remaining_energy_kwh?: number;
        recalculated_remaining_time_min?: number;
        projected_end_battery_pct?: number;
        weatherRefresh?: { samples?: unknown[] };
      };

      if (!response.ok) throw new Error(data.error || (locale === "fr" ? "La reprise a echoue." : "Resume failed."));

      const nextTrip: ActiveTripSession = {
        ...activeTrip,
        status: "in_progress",
      };
      persistActiveTrip(nextTrip);

      const refreshed = Array.isArray(data.weatherRefresh?.samples) ? data.weatherRefresh?.samples.length : 0;
      const remainingEnergy = Number(data.recalculated_remaining_energy_kwh ?? Number.NaN);
      const remainingTime = Number(data.recalculated_remaining_time_min ?? Number.NaN);
      const projectedEndBattery = Number(data.projected_end_battery_pct ?? Number.NaN);

      if (Number.isFinite(remainingEnergy) && Number.isFinite(remainingTime)) {
        const batteryText = Number.isFinite(projectedEndBattery)
          ? locale === "fr"
            ? ` Batterie projetee a l arrivee: ${projectedEndBattery.toFixed(1)}%.`
            : ` Projected battery on arrival: ${projectedEndBattery.toFixed(1)}%.`
          : "";
        setResumeMsg(
          locale === "fr"
            ? `Trajet relance. Reste estime: ${remainingEnergy.toFixed(1)} kWh et ${formatDuration(remainingTime)}.${batteryText} ${
                refreshed > 0 ? `${refreshed} points meteo ont ete rafraichis.` : ""
              }`
            : `Trip resumed. Estimated remaining: ${remainingEnergy.toFixed(1)} kWh and ${formatDuration(remainingTime)}.${batteryText} ${
                refreshed > 0 ? `${refreshed} weather points were refreshed.` : ""
              }`,
        );
      } else {
        setResumeMsg(locale === "fr" ? "Trajet relance avec les conditions meteo les plus recentes." : "Trip resumed with the latest weather conditions.");
      }
    } catch (err) {
      setResumeMsg(err instanceof Error ? err.message : locale === "fr" ? "Impossible de reprendre le trajet." : "Unable to resume the trip.");
    }
  };

  const completeTrip = () => {
    if (!route) return;
    const completedTrip = buildCompletedTrip(route, start, end);
    const nextHistory = [completedTrip, ...completedTrips].slice(0, 12);
    setCompletedTrips(nextHistory);
    writeJson(COMPLETED_TRIPS_KEY, nextHistory);
    persistActiveTrip(null);
    setPauseMsg("");
    setResumeMsg(locale === "fr" ? "Trajet marque comme termine et ajoute a l historique." : "Trip marked as completed and added to history.");
  };

  return (
    <section className="ecospeed-panel">
      <div className="ecospeed-panel__header">
        <div>
          <span className="ecospeed-section-label">{t.sectionLabel}</span>
          <h2>{t.sectionTitle}</h2>
          <p>{t.sectionIntro}</p>
        </div>
      </div>

      <div className="ecospeed-panel__grid">
        <div className="ecospeed-card">
          <form className="ecospeed-form" onSubmit={submitRoute}>
            <div className="ecospeed-field">
              <label htmlFor="trip-start">{t.start}</label>
              <input id="trip-start" value={start} onChange={(event) => setStart(event.target.value)} placeholder="Paris" />
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-end">{t.end}</label>
              <input id="trip-end" value={end} onChange={(event) => setEnd(event.target.value)} placeholder="Lyon" />
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-battery-start">{t.batteryStart}</label>
              <input
                id="trip-battery-start"
                type="number"
                min={5}
                max={100}
                value={batteryStart}
                onChange={(event) => setBatteryStart(Number(event.target.value))}
              />
              <span>{t.batteryStartHint}</span>
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-battery-end">{t.batteryEnd}</label>
              <input
                id="trip-battery-end"
                type="number"
                min={5}
                max={90}
                value={batteryEnd}
                onChange={(event) => setBatteryEnd(Number(event.target.value))}
              />
              <span>{t.batteryEndHint}</span>
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-passengers">{t.passengers}</label>
              <input
                id="trip-passengers"
                type="number"
                min={0}
                max={7}
                value={numPassengers}
                onChange={(event) => setNumPassengers(Number(event.target.value))}
              />
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-weight">{t.weight}</label>
              <input
                id="trip-weight"
                type="number"
                min={30}
                max={150}
                value={avgWeightKg}
                onChange={(event) => setAvgWeightKg(Number(event.target.value))}
              />
              <span>en kg</span>
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-comfort">{t.comfort}</label>
              <input
                id="trip-comfort"
                type="number"
                min={16}
                max={24}
                value={comfortTempC}
                onChange={(event) => setComfortTempC(Number(event.target.value))}
              />
              <span>{t.comfortHint}</span>
            </div>

            <div className="ecospeed-field">
              <label htmlFor="trip-vehicle">{t.vehicle}</label>
              <select id="trip-vehicle" value={vehiclePresetId} onChange={(event) => setVehiclePresetId(event.target.value)}>
                {VEHICLE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">{t.custom}</option>
              </select>
            </div>

            {vehiclePresetId === "custom" ? (
              <div className="ecospeed-field ecospeed-field--wide">
                <div className="ecospeed-inline-grid">
                  <div className="ecospeed-inline-field">
                    <label htmlFor="custom-mass">{t.mass}</label>
                    <input
                      id="custom-mass"
                      type="number"
                      value={customVehicle.empty_mass}
                      onChange={(event) =>
                        setCustomVehicle((current) => ({ ...current, empty_mass: Number(event.target.value) }))
                      }
                    />
                  </div>
                  <div className="ecospeed-inline-field">
                    <label htmlFor="custom-cx">{t.aero}</label>
                    <input
                      id="custom-cx"
                      type="number"
                      step="0.01"
                      value={customVehicle.drag_coefficient}
                      onChange={(event) =>
                        setCustomVehicle((current) => ({ ...current, drag_coefficient: Number(event.target.value) }))
                      }
                    />
                  </div>
                  <div className="ecospeed-inline-field">
                    <label htmlFor="custom-area">{t.area}</label>
                    <input
                      id="custom-area"
                      type="number"
                      step="0.01"
                      value={customVehicle.frontal_area}
                      onChange={(event) =>
                        setCustomVehicle((current) => ({ ...current, frontal_area: Number(event.target.value) }))
                      }
                    />
                  </div>
                  <div className="ecospeed-inline-field">
                    <label htmlFor="custom-battery">{t.battery}</label>
                    <input
                      id="custom-battery"
                      type="number"
                      step="0.1"
                      value={customVehicle.battery_kwh}
                      onChange={(event) =>
                        setCustomVehicle((current) => ({ ...current, battery_kwh: Number(event.target.value) }))
                      }
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="ecospeed-profile-note">{selectedPreset?.blurb[locale]}</p>
            )}

            <div className="ecospeed-actions">
              <button type="submit" className="ecospeed-button" disabled={loading}>
                {loading ? t.calculating : t.calculate}
              </button>
              {activeTrip ? (
                <button
                  type="button"
                  className="ecospeed-button--ghost"
                  onClick={() => {
                    persistActiveTrip(null);
                    setPauseMsg("");
                    setResumeMsg("");
                  }}
                >
                  {t.resetSession}
                </button>
              ) : null}
            </div>
          </form>

          {error ? <div className="ecospeed-feedback ecospeed-feedback--error">{error}</div> : null}

          {activeTrip ? (
            <div className="ecospeed-weather-overview" style={{ marginTop: 18 }}>
              <strong>{t.stateTitle}</strong>
              <p className="ecospeed-footnote">
                {activeTrip.status === "paused"
                  ? t.statePaused
                  : activeTrip.status === "in_progress"
                    ? t.stateProgress
                    : t.stateReady}
              </p>
              <div className="ecospeed-badge-row">
                <span className="ecospeed-badge">{activeTrip.start}</span>
                <span className="ecospeed-badge">{activeTrip.end}</span>
                <span className="ecospeed-badge">{t.createdOn} {formatDate(activeTrip.createdAtIso, locale)}</span>
                <span className="ecospeed-badge">{t.segment} {activeTrip.segmentIndex}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="ecospeed-card">
          <span className="ecospeed-section-label">{t.summary}</span>
          <h3>{t.summaryTitle}</h3>
          <p className="ecospeed-profile-note">{t.summaryIntro}</p>
          {route ? (
            <div className="ecospeed-story-grid">
              <article className="ecospeed-story-card">
                <span>{locale === "fr" ? "En roulant a la vitesse optimale" : "By driving at the optimized speed"}</span>
                <strong>{energySavedKwh.toFixed(1)} kWh</strong>
                <p>
                  {locale === "fr"
                    ? `Cela correspond a environ ${autonomyRecoveredKm.toFixed(0)} km d autonomie recuperes ou ${homeChargeHoursSaved.toFixed(1)} h de recharge a domicile.`
                    : `That equals about ${autonomyRecoveredKm.toFixed(0)} km of recovered range or ${homeChargeHoursSaved.toFixed(1)} h of home charging.`}
                </p>
              </article>
              <article className="ecospeed-story-card">
                <span>{locale === "fr" ? "Impact carbone evite" : "Avoided carbon impact"}</span>
                <strong>{co2SavedKg.toFixed(2)} kg CO2</strong>
                <p>{route.co2_equivalents?.message || formatCo2(co2SavedKg, locale)}</p>
              </article>
            </div>
          ) : null}
          <div className="ecospeed-kpi-grid">
            <div className="ecospeed-kpi">
              <span>{t.estimatedSavings}</span>
              <strong>{formatMoney(savingsEur)}</strong>
              <span>{savingsPct.toFixed(1)}% {locale === "fr" ? "vs trajet a la limite" : "vs speed-limit trip"}</span>
            </div>
            <div className="ecospeed-kpi">
              <span>{t.energySaved}</span>
              <strong>{energySavedKwh.toFixed(1)} kWh</strong>
              <span>{route ? formatCo2(Number(route.co2_avoided_kg ?? 0), locale) : locale === "fr" ? "En attente de calcul" : "Waiting for calculation"}</span>
            </div>
          </div>

          <div className="ecospeed-secondary-grid">
            <div className="ecospeed-stat">
              <span>{t.timeEco}</span>
              <strong>{route ? formatDuration(route.total_eco_time_min) : "--"}</strong>
            </div>
            <div className="ecospeed-stat">
              <span>{t.timeLimit}</span>
              <strong>{route ? formatDuration(route.total_limit_time_min) : "--"}</strong>
            </div>
            <div className="ecospeed-stat">
              <span>{t.rechargeEco}</span>
              <strong>{route ? `${route.recharge_needed_eco_kwh.toFixed(1)} kWh` : "--"}</strong>
            </div>
            <div className="ecospeed-stat">
              <span>{t.averageWind}</span>
              <strong>{route ? `${Number(route.weather_avg_wind_kmh ?? 0).toFixed(0)} km/h` : "--"}</strong>
            </div>
            <div className="ecospeed-stat">
              <span>{t.rangeRecovered}</span>
              <strong>{route ? `${autonomyRecoveredKm.toFixed(0)} km` : "--"}</strong>
            </div>
            <div className="ecospeed-stat">
              <span>{t.fastChargeEquivalent}</span>
              <strong>{route ? `${chargingSessionsSaved.toFixed(2)} ${locale === "fr" ? "session" : "session"}` : "--"}</strong>
            </div>
          </div>
        </div>
      </div>

      {route ? (
        <>
          <div className="ecospeed-summary-grid">
            <article className="ecospeed-stat">
              <span>{t.distance}</span>
              <strong>{route.total_distance_km.toFixed(1)} km</strong>
            </article>
            <article className="ecospeed-stat">
              <span>{t.fullEcoCost}</span>
              <strong>{formatMoney(totalTripCostEco)}</strong>
            </article>
            <article className="ecospeed-stat">
              <span>{t.fullLimitCost}</span>
              <strong>{formatMoney(totalTripCostLimit)}</strong>
            </article>
            <article className="ecospeed-stat">
              <span>{t.optimizedCharges}</span>
              <strong>{selectedChargingCount}</strong>
            </article>
          </div>

          <div className="ecospeed-results-nav" aria-label={t.resultsMenu}>
            {resultTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`ecospeed-results-nav__button ${activeResultsTab === tab.id ? "is-active" : ""}`}
                onClick={() => setActiveResultsTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {showEssentials ? (
            <>
              <section className="ecospeed-drive-card">
                <div className="ecospeed-drive-card__header">
                  <span className="ecospeed-section-label">{t.quickDrive}</span>
                  <h3>{t.quickDriveTitle}</h3>
                </div>
                <div className="ecospeed-drive-grid">
                  <article className="ecospeed-drive-metric">
                    <span>{t.targetSpeed}</span>
                    <strong>{currentDriveSegment ? `${Math.round(currentDriveSegment.eco_speed)} km/h` : "--"}</strong>
                  </article>
                  <article className="ecospeed-drive-metric">
                    <span>{t.currentSection}</span>
                    <strong>
                      {currentDriveSegment
                        ? `${currentDriveSegment.distance_km.toFixed(1)} km`
                        : "--"}
                    </strong>
                  </article>
                  <article className="ecospeed-drive-metric">
                    <span>{t.nextCharge}</span>
                    <strong>
                      {nextChargingStop
                        ? `${nextChargingStop.station.name} (${t.segment} ${nextChargingStop.segmentIndex})`
                        : t.noChargeNeeded}
                    </strong>
                    {nextChargingStop ? (
                      <span>
                        {t.chargeMinimumTime} {formatDuration(nextChargingStop.computedMinimumChargingTimeMinutes)}
                      </span>
                    ) : null}
                  </article>
                  <article className="ecospeed-drive-metric">
                    <span>{t.arrivalTarget}</span>
                    <strong>{batteryEnd}%</strong>
                  </article>
                </div>
                {showMotorwayGuardrail ? <p className="ecospeed-footnote">{t.motorwayGuardrail}</p> : null}
              </section>

              <section className="ecospeed-card ecospeed-card--plain">
                <span className="ecospeed-section-label">{t.achievements}</span>
                <h3>{t.achievementsTitle}</h3>
                <p className="ecospeed-profile-note">{t.achievementsText}</p>
                <div className="ecospeed-achievements-grid">
                  {achievements.map((badge) => (
                    <article
                      key={badge.id}
                      className={`ecospeed-achievement ${badge.earned ? "is-earned" : ""}`}
                    >
                      <span className="ecospeed-achievement__status">
                        {badge.earned ? t.unlocked : t.locked}
                      </span>
                      <strong>{badge.title[locale]}</strong>
                      <p>{badge.description[locale]}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="ecospeed-card ecospeed-card--plain">
                <span className="ecospeed-section-label">{t.gainsTitle}</span>
                <h3>{t.gainsIntro}</h3>
                <div className="ecospeed-gains-grid">
                  <article className="ecospeed-gain-card">
                    <span>{locale === "fr" ? "Energie preservee" : "Energy preserved"}</span>
                    <strong>{energySavedKwh.toFixed(1)} kWh</strong>
                    <p>{t.homeCharge} {homeChargeHoursSaved.toFixed(1)} {t.homeChargeSuffix}</p>
                  </article>
                  <article className="ecospeed-gain-card">
                    <span>{locale === "fr" ? "Autonomie recuperable" : "Recovered range"}</span>
                    <strong>{autonomyRecoveredKm.toFixed(0)} km</strong>
                    <p>{t.couldBeUsed}</p>
                  </article>
                  <article className="ecospeed-gain-card">
                    <span>{locale === "fr" ? "CO2 evite" : "CO2 avoided"}</span>
                    <strong>{co2SavedKg.toFixed(2)} kg</strong>
                    <p>{formatCo2(co2SavedKg, locale)}</p>
                  </article>
                  <article className="ecospeed-gain-card">
                    <span>{locale === "fr" ? "Argent garde" : "Money kept"}</span>
                    <strong>{formatMoney(savingsEur)}</strong>
                    <p>{formatPercent(savingsPct)} {t.lessThanTrip}</p>
                  </article>
                </div>
              </section>

              <div className="ecospeed-comparison">
                <table>
                  <thead>
                    <tr>
                      <th>{t.comparison}</th>
                      <th>Eco</th>
                      <th>{t.limit}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{locale === "fr" ? "Energie totale" : "Total energy"}</td>
                      <td>{route.total_eco_energy.toFixed(1)} kWh</td>
                      <td>{route.total_limit_energy.toFixed(1)} kWh</td>
                    </tr>
                    <tr>
                      <td>{locale === "fr" ? "Total time" : "Total time"}</td>
                      <td>{formatDuration(route.total_eco_time_min)}</td>
                      <td>{formatDuration(route.total_limit_time_min)}</td>
                    </tr>
                    <tr>
                      <td>{locale === "fr" ? "Cout roulage + recharge" : "Driving + charging cost"}</td>
                      <td>{formatMoney(totalTripCostEco)}</td>
                      <td>{formatMoney(totalTripCostLimit)}</td>
                    </tr>
                    <tr>
                      <td>{locale === "fr" ? "Recharge necessaire" : "Required charge"}</td>
                      <td>{route.recharge_needed_eco_kwh.toFixed(1)} kWh</td>
                      <td>{route.recharge_needed_limit_kwh.toFixed(1)} kWh</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {showAnalysis ? (
            <section className="ecospeed-card ecospeed-card--plain">
            <span className="ecospeed-section-label">{t.segmentBreakdown}</span>
            <h3>{t.segmentBreakdownTitle}</h3>
            <p className="ecospeed-profile-note">{t.segmentBreakdownText}</p>
            <div className="ecospeed-badge-row">
              <span className="ecospeed-badge">{route.segments.length} {t.segmentsAnalysed}</span>
              <span className="ecospeed-badge">{segmentEnergySavedKwh.toFixed(1)} kWh {t.gainedOverall}</span>
            </div>
            <div className="ecospeed-segment-table">
              <table>
                <thead>
                  <tr>
                    <th>{t.segment}</th>
                    <th>{t.distance}</th>
                    <th>{locale === "fr" ? "Vitesse eco" : "Eco speed"}</th>
                    <th>{t.limit}</th>
                    <th>{locale === "fr" ? "Energie eco" : "Eco energy"}</th>
                    <th>{t.gain}</th>
                    <th>{t.timeEco}</th>
                    <th>{t.weatherLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {route.segments.map((segment) => {
                    const segmentGainKwh = Math.max(0, segment.limit_energy - segment.eco_energy);
                    const segmentGainPct =
                      segment.limit_energy > 0 ? (segmentGainKwh / segment.limit_energy) * 100 : 0;
                    return (
                      <tr key={segment.idx}>
                        <td>
                          <strong>S{segment.idx}</strong>
                        </td>
                        <td>{segment.distance_km.toFixed(1)} km</td>
                        <td>{Math.round(segment.eco_speed)} km/h</td>
                        <td>{Math.round(segment.speed_limit)} km/h</td>
                        <td>{segment.eco_energy.toFixed(2)} kWh</td>
                        <td>
                          {segmentGainKwh.toFixed(2)} kWh
                          <br />
                          <span>{formatPercent(segmentGainPct)}</span>
                        </td>
                        <td>{formatDuration(segment.eco_time_min)}</td>
                        <td>
                          {segment.temp_c_avg.toFixed(1)} C
                          <br />
                          <span>{segment.rain_mmh_avg.toFixed(2)} mm/h</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </section>
          ) : null}

          {showCharging || showTrip ? (
            <div className="ecospeed-bottom-grid">
            <div>
              {showCharging ? (
                <>
                  <section className="ecospeed-map-card">
                    <span className="ecospeed-section-label">{t.map}</span>
                    <h3>{t.mapTitle}</h3>
                    <p>{t.mapText}</p>
                    <TripMap
                      optimizedPath={route.route_coordinates}
                      chargingStops={selectedChargingPlan.map((stop) => ({
                        ...stop,
                        energyToCharge: stop.computedChosenEnergyKwh,
                        chargingTimeMinutes: stop.computedChosenChargingTimeMinutes,
                      }))}
                      nearbyStations={routeStations}
                      locale={locale}
                    />
                    <div className="ecospeed-map-legend">
                      <span>
                        <i className="ecospeed-map-dot ecospeed-map-dot--route" />
                        {t.routeLegend}
                      </span>
                      <span>
                        <i className="ecospeed-map-dot ecospeed-map-dot--stop" />
                        {t.stopLegend}
                      </span>
                      <span>
                        <i className="ecospeed-map-dot ecospeed-map-dot--nearby" />
                        {t.nearbyLegend}
                      </span>
                    </div>
                  </section>

                  <section className="ecospeed-weather-card">
                    <span className="ecospeed-section-label">{t.weather}</span>
                    <h3>{t.weatherTitle}</h3>
                    <div className="ecospeed-weather-tags">
                      <span>{Number(route.weather_temperature_min_c ?? route.weather_avg_temp_c).toFixed(1)} C min</span>
                      <span>{Number(route.weather_temperature_max_c ?? route.weather_avg_temp_c).toFixed(1)} C max</span>
                      <span>{route.weather_avg_rain_mmh.toFixed(2)} mm/h {locale === "fr" ? "pluie moyenne" : "average rain"}</span>
                      <span>{Number(route.weather_impact_eco_kwh ?? 0).toFixed(2)} kWh {t.weatherImpact}</span>
                    </div>
                    <WeatherTrendChart data={weatherSamples} locale={locale} />
                    <div className="ecospeed-weather-overview">
                      <strong>{t.co2Equivalent}</strong>
                      <p className="ecospeed-footnote">
                        {route.co2_equivalents?.message || formatCo2(Number(route.co2_avoided_kg ?? 0), locale)}
                      </p>
                    </div>
                  </section>
                </>
              ) : null}
            </div>

            <div>
              {showTrip ? (
                <section className="ecospeed-card">
                <span className="ecospeed-section-label">{t.tripManagement}</span>
                <h3>{t.tripManagementTitle}</h3>
                <div className="ecospeed-inline-grid ecospeed-inline-grid--trip">
                  <div className="ecospeed-inline-field">
                    <label htmlFor="trip-stop-segment">{t.currentSegment}</label>
                    <input
                      id="trip-stop-segment"
                      type="number"
                      min={1}
                      max={Math.max(1, route.segments.length)}
                      value={stopSegment}
                      onChange={(event) => setStopSegment(Number(event.target.value))}
                    />
                  </div>
                  <div className="ecospeed-inline-field">
                    <label htmlFor="trip-battery-before">{t.batteryBeforeStop}</label>
                    <input
                      id="trip-battery-before"
                      type="number"
                      min={0}
                      max={100}
                      value={batteryBefore}
                      onChange={(event) => setBatteryBefore(Number(event.target.value))}
                    />
                  </div>
                  <div className="ecospeed-inline-field">
                    <label htmlFor="trip-battery-after">{t.batteryAfterStop}</label>
                    <input
                      id="trip-battery-after"
                      type="number"
                      min={0}
                      max={100}
                      value={batteryAfter}
                      onChange={(event) => setBatteryAfter(Number(event.target.value))}
                    />
                  </div>
                  <div className="ecospeed-inline-field">
                    <label htmlFor="trip-recharge-state">{t.rechargeDone}</label>
                    <select
                      id="trip-recharge-state"
                      value={didRecharge ? "yes" : "no"}
                      onChange={(event) => setDidRecharge(event.target.value === "yes")}
                    >
                      <option value="yes">{t.yes}</option>
                      <option value="no">{t.no}</option>
                    </select>
                  </div>
                </div>

                <div className="ecospeed-trip-actions" style={{ marginTop: 16 }}>
                  <button type="button" className="ecospeed-button" onClick={pauseTrip}>
                    {t.pause}
                  </button>
                  <button type="button" className="ecospeed-button--ghost" onClick={resumeTrip}>
                    {t.resume}
                  </button>
                  <button type="button" className="ecospeed-button--soft" onClick={completeTrip}>
                    {t.finish}
                  </button>
                </div>

                {pauseMsg ? <div className="ecospeed-feedback ecospeed-feedback--ok">{pauseMsg}</div> : null}
                {resumeMsg ? <div className="ecospeed-feedback ecospeed-feedback--ok">{resumeMsg}</div> : null}
                {route.warnings && route.warnings.length > 0 ? (
                  <div className="ecospeed-feedback ecospeed-feedback--error">
                    {route.warnings.slice(0, 2).join(" ")}
                  </div>
                ) : null}
                </section>
              ) : null}

              {showCharging ? (
                <section className="ecospeed-card">
                <span className="ecospeed-section-label">{t.chargePlan}</span>
                <h3>{t.chargePlanTitle}</h3>
                <p className="ecospeed-profile-note">{t.chargePlanText}</p>
                {route.routeChargingStations.length === 0 ? (
                  <div className="ecospeed-empty-state">{t.noStopNeeded}</div>
                ) : (
                  <>
                    <p className="ecospeed-footnote">{t.chargeSelectionHint}</p>
                    {chargeSelectionError ? <div className="ecospeed-feedback ecospeed-feedback--error">{chargeSelectionError}</div> : null}
                    <div className="ecospeed-stop-list">
                      {route.routeChargingStations.map((stop, index) => {
                        const stopKey = buildStopKey(stop, index);
                        const selected = selectedStopsByKey[stopKey] !== false;
                        const recomputedStop = selectedChargingPlanByKey.get(stopKey) ?? null;
                        const arrivalPct = selected
                          ? Number(recomputedStop?.computedBatteryLevelAtCharge ?? stop.batteryLevelAtCharge ?? 0)
                          : Number(stop.batteryLevelAtCharge ?? 0);
                        const minimumTargetPct = selected
                          ? Number(recomputedStop?.computedMinimumTargetBatteryPct ?? stop.minimumTargetBatteryPct ?? stop.batteryPctAfterCharge ?? 0)
                          : Number(stop.minimumTargetBatteryPct ?? stop.batteryPctAfterCharge ?? stop.targetBatteryPct ?? 0);
                        const minimumEnergyKwh = selected
                          ? Number(recomputedStop?.computedMinimumEnergyToCharge ?? stop.minimumEnergyToCharge ?? stop.energyToCharge ?? 0)
                          : Number(stop.minimumEnergyToCharge ?? stop.energyToCharge ?? 0);
                        const minimumMinutes = selected
                          ? Number(recomputedStop?.computedMinimumChargingTimeMinutes ?? stop.minimumChargingTimeMinutes ?? stop.chargingTimeMinutes ?? 0)
                          : Number(stop.minimumChargingTimeMinutes ?? stop.chargingTimeMinutes ?? 0);
                        const chosenTargetPct = selected
                          ? Number(recomputedStop?.computedChosenTargetPct ?? minimumTargetPct)
                          : clamp(Number(chargeTargetsByStop[stopKey] ?? Math.ceil(minimumTargetPct)), Math.ceil(minimumTargetPct), 95);
                        const chosenEnergyKwh = selected
                          ? Number(recomputedStop?.computedChosenEnergyKwh ?? 0)
                          : Math.max(0, routeBatteryKwh * ((chosenTargetPct - Math.max(0, arrivalPct)) / 100));
                        const chosenMinutes = selected
                          ? Number(recomputedStop?.computedChosenChargingTimeMinutes ?? 0)
                          : 0;
                        const estimatedCost = selected
                          ? Number(recomputedStop?.computedEstimatedChargeCostEur ?? stop.estimatedChargeCostEur ?? 0)
                          : Number(stop.estimatedChargeCostEur ?? 0);
                        const driveTimeMin = selected
                          ? Number(recomputedStop?.computedDriveTimeFromPreviousStopMin ?? stop.driveTimeFromPreviousStopMin ?? 0)
                          : Number(stop.driveTimeFromPreviousStopMin ?? 0);
                        const driveDistanceKm = selected
                          ? Number(recomputedStop?.computedDriveDistanceFromPreviousStopKm ?? stop.driveDistanceFromPreviousStopKm ?? 0)
                          : Number(stop.driveDistanceFromPreviousStopKm ?? 0);
                        const strategicPause = driveTimeMin >= 100 && driveTimeMin <= 140;

                        return (
                          <article key={stopKey} className={`ecospeed-stop ${selected ? "" : "is-inactive"}`}>
                            <div className="ecospeed-stop__topline">
                              <label className="ecospeed-stop__toggle" htmlFor={`charge-stop-${index}`}>
                                <input
                                  id={`charge-stop-${index}`}
                                  type="checkbox"
                                  checked={selected}
                                  onChange={(event) => toggleChargingStop(stopKey, event.target.checked)}
                                />
                                <span>{t.rechargeHere}</span>
                              </label>
                              <span className="ecospeed-chip">{stop.station.powerKw} kW</span>
                            </div>

                            <div className="ecospeed-stop__title">
                              <strong>{`${index + 1}. ${stop.station.name}`}</strong>
                            </div>

                            <div className="ecospeed-stop__meta">
                              <span>{t.chargingStationSegment} {stop.segmentIndex}</span>
                              {driveTimeMin > 0 ? <span>{t.chargeAfterDriving} {formatDuration(driveTimeMin)}</span> : null}
                              {driveDistanceKm > 0 ? <span>{driveDistanceKm.toFixed(0)} km</span> : null}
                            </div>

                            {selected ? <small>{t.recalculatedStop}</small> : null}
                            {selected && recomputedStop?.unreachable ? (
                              <div className="ecospeed-feedback ecospeed-feedback--error">
                                {recomputedStop.unreachableByKwh > 0
                                  ? `${t.unreachableStop} ${
                                      locale === "fr"
                                        ? `${recomputedStop.unreachableByKwh.toFixed(1)} kWh manquants avant la borne.`
                                        : `${recomputedStop.unreachableByKwh.toFixed(1)} kWh missing before the stop.`
                                    }`
                                  : recomputedStop.postChargeShortfallKwh > 0
                                    ? `${t.unreachableStop} ${
                                        locale === "fr"
                                          ? `${recomputedStop.postChargeShortfallKwh.toFixed(1)} kWh supplementaires seraient encore necessaires apres la recharge.`
                                          : `${recomputedStop.postChargeShortfallKwh.toFixed(1)} kWh would still be needed after charging.`
                                      }`
                                    : t.unreachableStop}
                              </div>
                            ) : null}

                            <span>
                              {locale === "fr" ? "Batterie a l arrivee a cette borne" : "Battery on arrival at this stop"}: {arrivalPct.toFixed(1)}%
                            </span>
                            <span>
                              {t.chargeMinimum}: {minimumEnergyKwh.toFixed(1)} kWh jusqu a {minimumTargetPct.toFixed(0)}%
                            </span>
                            <span>
                              {t.chargeMinimumTime}: {formatDuration(minimumMinutes)}
                            </span>

                            <div className="ecospeed-stop__planner">
                              <label htmlFor={`charge-target-${index}`}>{t.chargeChosenTarget}</label>
                              <input
                                id={`charge-target-${index}`}
                                type="number"
                                min={Math.ceil(minimumTargetPct)}
                                max={95}
                                disabled={!selected}
                                value={chosenTargetPct}
                                onChange={(event) => {
                                  const nextTarget = clamp(Number(event.target.value), Math.ceil(minimumTargetPct), 95);
                                  setChargeTargetsByStop((current) => ({ ...current, [stopKey]: nextTarget }));
                                }}
                              />
                              <span>{t.chargeTargetHint}</span>
                            </div>

                            <span>
                              {t.chargeChosenEnergy}: {chosenEnergyKwh.toFixed(1)} kWh jusqu a {chosenTargetPct.toFixed(0)}%
                            </span>
                            <span>
                              {t.chargeChosenTime}: {formatDuration(chosenMinutes)}
                            </span>

                            <small>
                              {estimatedCost > 0 ? `${formatMoney(estimatedCost)} ${t.costEstimated}` : t.costIncluded}
                              {stop.distKmFromRoute ? `, ${t.detour} ${stop.distKmFromRoute.toFixed(1)} km` : ""}
                              {strategicPause ? `, ${t.strategicPause}` : ""}
                            </small>
                          </article>
                        );
                      })}
                    </div>
                  </>
                )}
                </section>
              ) : null}
            </div>
            </div>
          ) : null}

          {showCharging ? <NearbyStationsPanel routeStations={routeStations} locale={locale} /> : null}
        </>
      ) : null}

      {!route || showTrip ? (
        <section className="ecospeed-history-card">
        <span className="ecospeed-section-label">{t.history}</span>
        <h3>{t.historyTitle}</h3>
        <p>{t.historyText}</p>
        {completedTrips.length === 0 ? (
          <div className="ecospeed-history-empty">{t.historyEmpty}</div>
        ) : (
          <div className="ecospeed-history-grid">
            {completedTrips.map((trip) => (
              <article key={trip.id} className="ecospeed-history-item">
                <span>
                  {trip.start} {"->"} {trip.end}
                </span>
                <strong>{trip.distanceKm.toFixed(0)} km</strong>
                <span>{formatDate(trip.completedAtIso, locale)}</span>
                <span>{trip.energySavedKwh.toFixed(1)} kWh {locale === "fr" ? "economises" : "saved"}</span>
                <span>{formatMoney(trip.savingsEur)} {locale === "fr" ? "gagnes" : "saved"}</span>
                <span>{trip.chargingStops} {locale === "fr" ? "arret(s) de charge" : "charging stop(s)"}</span>
              </article>
            ))}
          </div>
        )}
        </section>
      ) : null}
    </section>
  );
}
