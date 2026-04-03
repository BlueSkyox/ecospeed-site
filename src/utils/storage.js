const STORAGE_KEYS = {
  API_KEYS: "ecospeed.apiKeys",
  HISTORY: "ecospeed.history",
  PREFERENCES: "ecospeed.preferences",
};

const parseJson = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const getApiKeys = () => {
  const stored = parseJson(localStorage.getItem(STORAGE_KEYS.API_KEYS), {});
  return {
    orsKey: stored.orsKey ?? "",
    ocmKey: stored.ocmKey ?? "",
  };
};

export const saveApiKeys = (keys) => {
  localStorage.setItem(STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
};

export const getTripHistory = () => {
  return parseJson(localStorage.getItem(STORAGE_KEYS.HISTORY), []);
};

export const saveTripHistory = (history) => {
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
};

export const clearTripHistory = () => {
  localStorage.removeItem(STORAGE_KEYS.HISTORY);
};

export const getPreferences = () => {
  return parseJson(localStorage.getItem(STORAGE_KEYS.PREFERENCES), {
    lastMode: "equilibre",
    cabinTemp: 21,
    arrivalSocTarget: 20,
    locale: "fr",
    theme: "light",
    defaultDisplayMode: "simple",
    defaultKwhPrice: 0.45,
    units: "whkm",
  });
};

export const savePreferences = (preferences) => {
  localStorage.setItem(STORAGE_KEYS.PREFERENCES, JSON.stringify(preferences));
};

export const pushHistoryEntry = (entry, max = 50) => {
  const history = getTripHistory();
  const next = [entry, ...history].slice(0, max);
  saveTripHistory(next);
  return next;
};




