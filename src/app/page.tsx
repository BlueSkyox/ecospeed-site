"use client";

import { useState } from "react";
import LaunchControlPanel from "@/components/LaunchControlPanel";

type Locale = "fr" | "en";

const LOCALE_KEY = "ecospeed_locale_v1";

const copy = {
  fr: {
    eyebrow: "EcoSpeed / planificateur VE",
    title: "Des trajets electriques clairs, utiles et faciles a suivre.",
    intro:
      "Calculez une vitesse eco realiste, comprenez vos gains tout de suite et gardez une lecture simple du trajet avant et pendant la route.",
    proofPoints: [
      "Economies d energie et de CO2 faciles a lire",
      "Segments avec vitesse optimale sur chaque portion",
      "Plan de charge et carte dans une seule vue",
    ],
    pillars: [
      {
        title: "Lecture immediate",
        text: "Les chiffres importants sont traduits en gains concrets: energie, argent, autonomie et CO2.",
      },
      {
        title: "Aide a la conduite",
        text: "Les informations critiques restent grosses, directes et faciles a retrouver sans surcharge visuelle.",
      },
      {
        title: "Suivi motivant",
        text: "Les badges et l historique encouragent l utilisateur a revenir et a mesurer ses progres.",
      },
    ],
  },
  en: {
    eyebrow: "EcoSpeed / EV trip planner",
    title: "Clear electric trips that are easy to understand and easy to follow.",
    intro:
      "Calculate a realistic eco speed, understand your savings instantly, and keep a simple trip view before and during the drive.",
    proofPoints: [
      "Energy and CO2 savings explained clearly",
      "Segment-by-segment optimal speed guidance",
      "Charging plan and map in one place",
    ],
    pillars: [
      {
        title: "Instant reading",
        text: "The key numbers are translated into concrete gains: energy, money, range and CO2.",
      },
      {
        title: "Driving support",
        text: "Critical information stays large, direct and easy to find without visual overload.",
      },
      {
        title: "Motivating follow-up",
        text: "Badges and trip history encourage users to come back and track their progress.",
      },
    ],
  },
} as const;

export default function Home() {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window === "undefined") return "fr";
    try {
      const stored = window.localStorage.getItem(LOCALE_KEY);
      return stored === "fr" || stored === "en" ? stored : "fr";
    } catch {
      return "fr";
    }
  });

  const setNextLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_KEY, nextLocale);
    } catch {}
  };

  const t = copy[locale];

  return (
    <main className="ecospeed-shell">
      <section className="ecospeed-hero">
        <div className="ecospeed-hero__copy">
          <div className="ecospeed-hero__topbar">
            <span className="ecospeed-eyebrow">{t.eyebrow}</span>
            <div className="ecospeed-locale-switch" aria-label="Language switch">
              <button
                type="button"
                className={locale === "fr" ? "is-active" : ""}
                onClick={() => setNextLocale("fr")}
              >
                FR
              </button>
              <button
                type="button"
                className={locale === "en" ? "is-active" : ""}
                onClick={() => setNextLocale("en")}
              >
                EN
              </button>
            </div>
          </div>
          <h1>{t.title}</h1>
          <p>{t.intro}</p>
          <div className="ecospeed-proof-strip">
            {t.proofPoints.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="ecospeed-pillars">
        {t.pillars.map((pillar) => (
          <article key={pillar.title} className="ecospeed-pillar">
            <h2>{pillar.title}</h2>
            <p>{pillar.text}</p>
          </article>
        ))}
      </section>

      <LaunchControlPanel locale={locale} />
    </main>
  );
}
