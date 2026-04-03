const WEATHER_BASE = "https://api.open-meteo.com/v1/forecast";

const toWeatherPayload = (data) => ({
  tempC: data?.current?.temperature_2m ?? 15,
  precipMmH: data?.current?.precipitation ?? 0,
  windKmh: data?.current?.wind_speed_10m ?? 0,
  windDirDeg: data?.current?.wind_direction_10m ?? 0,
});

export const getWeatherAt = async (lat, lng) => {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m",
    timezone: "auto",
  });

  const res = await fetch(`${WEATHER_BASE}?${params.toString()}`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error("Impossible de récupérer la météo Open-Meteo.");
  }

  return toWeatherPayload(data);
};

export const hydrateSegmentsWeather = async (segments) => {
  const chunked = [];
  for (let i = 0; i < segments.length; i += 4) {
    chunked.push(segments.slice(i, i + 4));
  }

  const enriched = [];
  for (const chunk of chunked) {
    const batch = await Promise.all(
      chunk.map(async (seg) => {
        try {
          const weather = await getWeatherAt(seg.refCoord.lat, seg.refCoord.lng);
          return {
            ...seg,
            tExt: weather.tempC,
            precip: weather.precipMmH,
            windKmh: weather.windKmh,
            windDirDeg: weather.windDirDeg,
          };
        } catch {
          return { ...seg, tExt: 15, precip: 0, windKmh: 0, windDirDeg: 0 };
        }
      })
    );
    enriched.push(...batch);
  }

  return enriched;
};
