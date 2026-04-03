# EcoSpeed

Application React + Vite pour estimer un trajet en VE avec:

- optimisation de vitesse basee sur un modele physique
- estimation d'energie, temps de conduite et recharges
- prise en compte de la meteo, des pentes, du vent et de la temperature
- affichage des bornes proches du trajet

## Prerequis

- Node.js 20+ recommande
- une cle OpenRouteService

## Lancement local

1. Installer les dependances:

```bash
npm install
```

2. Creer un fichier `.env.local` a partir de `.env.example`:

```bash
cp .env.example .env.local
```

3. Renseigner au minimum:

```bash
OPENROUTESERVICE_API_KEY=your_openrouteservice_key_here
```

4. Lancer le serveur:

```bash
npm run dev
```

5. Ouvrir:

```text
http://localhost:5173
```

## Verification avant mise en ligne

```bash
npm run lint
npx tsc -p tsconfig.json --noEmit
npm run build
```

## Deploiement sur Vercel

### Option simple via GitHub

1. Pousser le projet sur GitHub.
2. Aller sur Vercel et cliquer sur `Add New... > Project`.
3. Importer le repo GitHub.
4. Laisser Vercel detecter `Vite`, ou verifier dans `Settings > Build and Output Settings` que le framework est `Vite`.
5. Ajouter les variables d'environnement dans `Project Settings > Environment Variables`.
6. Lancer le deploiement.

### Variables d'environnement Vercel

Variable requise:

```text
OPENROUTESERVICE_API_KEY
```

Variables optionnelles:

```text
DEFAULT_RHO_AIR_REF
DEFAULT_REGEN_MAX_KW
DEFAULT_GRID_CO2_KG_PER_KWH
DEFAULT_FOSSIL_FUEL_EUR_PER_L
TOLL_RATE_EUR_PER_KM
```

## Deploiement via CLI Vercel

```bash
npm i -g vercel
vercel
vercel --prod
```

## Checklist equipe

- le repo est sur GitHub
- `OPENROUTESERVICE_API_KEY` est configuree sur Vercel
- `npm run build` passe en local
- la page d'accueil charge
- un calcul de trajet fonctionne
- la carte et les bornes s'affichent

## Important

- La cle OpenRouteService embarquee a ete retiree du code.
- En production, si `OPENROUTESERVICE_API_KEY` ou `ORS_API_KEY` manque, les endpoints relies au calcul d'itineraire echoueront explicitement.

## Scripts utiles

```bash
npm run dev
npm run build
npm run lint
```
