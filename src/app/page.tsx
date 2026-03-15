"use client";

import { useState } from "react";
import LaunchControlPanel from "@/components/LaunchControlPanel";

type Locale = "fr" | "en";

const LOCALE_KEY = "ecospeed_locale_v1";

const copy = {
  fr: {
    eyebrow: "EcoSpeed / planificateur VE",
    title: "Le copilote VE qui rend chaque trajet plus clair, plus fiable et plus simple a suivre.",
    intro:
      "EcoSpeed transforme un calcul technique en decisions lisibles: vitesse eco credible, batterie resolue en kWh, impact meteo reconstitue sur le trajet et pauses de recharge vraiment utiles.",
    proofPoints: [
      "Batterie traduite en kWh reel selon le vehicule choisi",
      "Vent, temperature et denivele pris en compte sur le parcours",
      "Plan de charge, carte et lecture conduite dans une seule interface",
    ],
    panelKicker: "Pourquoi c est plus fiable",
    panelTitle: "Une lecture claire, sans masquer la physique du trajet.",
    panelPoints: [
      "La recommandation de vitesse suit le profil altimetrique du parcours, pas une moyenne abstraite.",
      "Le vent et la temperature sont recuperes sur la route pour rendre la conso HVAC et aero plus credibles.",
      "Les gains sont traduits en kWh, euros, autonomie recuperee et temps de recharge equivalent.",
    ],
    pillars: [
      {
        title: "Comprendre en 10 secondes",
        text: "Les chiffres importants sont reformules en decisions: quelle vitesse viser, combien vous gagnez et quand recharger.",
      },
      {
        title: "Faire confiance au calcul",
        text: "La batterie, la masse, la meteo et le relief sont relies au modele pour eviter les raccourcis trompeurs.",
      },
      {
        title: "Rester serein sur la route",
        text: "La vue conduite, l historique local et les badges gardent l experience utile avant, pendant et apres le trajet.",
      },
    ],
  },
  en: {
    eyebrow: "EcoSpeed / EV trip planner",
    title: "The EV co-pilot that makes every trip clearer, more reliable and easier to follow.",
    intro:
      "EcoSpeed turns a technical simulation into readable decisions: credible eco speed, battery resolved in kWh, route-based weather impact and charging stops that are actually useful.",
    proofPoints: [
      "Battery translated into real kWh for the selected vehicle",
      "Wind, temperature and elevation included along the route",
      "Charging plan, map and drive view in one interface",
    ],
    panelKicker: "Why it feels more trustworthy",
    panelTitle: "A clearer view, without hiding the trip physics.",
    panelPoints: [
      "The recommended speed follows the elevation profile instead of relying on an abstract average.",
      "Wind and temperature are sampled along the route so HVAC and aero consumption stay believable.",
      "Savings are translated into kWh, money, recovered range and equivalent charging time.",
    ],
    pillars: [
      {
        title: "Understand it in 10 seconds",
        text: "The key numbers are phrased as decisions: what speed to target, how much you save and when to charge.",
      },
      {
        title: "Trust the calculation",
        text: "Battery, mass, weather and elevation stay connected to the model instead of being treated as rough guesses.",
      },
      {
        title: "Stay calm on the road",
        text: "The drive view, local history and badges keep the experience useful before, during and after the trip.",
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
        <aside className="ecospeed-hero__panel">
          <span className="ecospeed-kicker">{t.panelKicker}</span>
          <h2>{t.panelTitle}</h2>
          <ul className="ecospeed-checklist">
            {t.panelPoints.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
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
