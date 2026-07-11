# TODO — DHS Playbook

Ostrukturerad men kategoriserad att-göra-lista. Uppdatera i klartext när nya idéer dyker upp eller när något är klart (flytta till "Klart" med kort motivering, för spårbarhet).

## Nya funktioner

Sånt som inte finns än — helt nya delar av produkten.

- **Single player-läge** *(framtid, inte aktuellt nu)* — ett läge för den som spelar pubmatcher själv (inte på LAN) och vill ha samma typ av kul: roliga utmaningar, "produktion" (typ hype/recap) och statistik på sina egna matcher. Kräver eftertanke kring datamodell (separat från lag-matcherna) och vad som är rimligt att generera per match för en enda spelare. Bara en idé att inte tappa bort.

## Förbättringar

Befintliga funktioner som funkar men kan bli bättre.

- **Streaming av strategitext** — visa AI-svaret i realtid medan det genereras istället för att vänta på hela svaret innan något visas.

## Buggfixar / teknisk skuld

Kända problem som inte stoppar produkten men bör åtgärdas.

- **`recap-history.json` är fortfarande diskbaserad och efemär.** Samma bugg som studioljudet hade (Railways filsystem nollställs vid varje deploy), men mindre allvarlig — filen håller bara koll på senaste vinklarna i studioanalyser för att undvika upprepning. Vid förlust: ingen dataförlust som märks, bara risk för lite mer repetitiva vinklar i nya analyser tills historiken byggts upp igen. Kan flyttas till JSONBin på samma sätt som studioljudet (`50f5638`, `7bdb935`) om det blir ett faktiskt problem.
- **Bara 6 av 9 spelare hittades i spelar-binet** när `link-matches.js` kördes (2026-07-11) — Gojja, Robin Hood och Skiipa saknades. Oklart om de aldrig lagts till, eller om något annat är fel. Bör kollas på Hero Pool-sidan.
- **`dotaconstants`-modulen saknas lokalt**, vilket gör att `link-matches.js` hoppar över hjältematchning (bara alias-matchning kvar, sämre träffsäkerhet i poängsättningen). Kör `npm install dotaconstants` för att fixa.

## Klart (flyttat hit vid färdigställande, för spårbarhet)

- **PIN-skydd för Strats/Historik** — löstes istället genom att bygga en separat `pool.html`-sida (egen JSONBin-bin) som spelarna kunde nå inför lanet utan att se Strats/Historik. Inte aktuellt längre efter lanet.
- **Hjältporträtt i historiklistan** — använder `heroImgByName` konsekvent med fallback-ikon när bild saknas.
- **Steam-ID på spelare** — nytt fält på Hero Pool-sidan, normaliserar SteamID64/OpenDota-ID/profil-länk till account_id (`b89bfb9`).
- **`link-matches.js` läser Steam-ID från spelar-binet** istället för en lokal `player-accounts.json`-fil (`042aaf1`).
- **Studioljud överlever inte längre Railway-deploys** — flyttat från disk till JSONBin, en bin per replik pga JSONBins 1MiB-uppladdningstak (`50f5638`, `7bdb935`).
- **TV-studions repliktext ersatt med "studiobord"** — tre paneldelar som lyser upp/pulserar istället för uppläsningstext på skärmen (`31cce3b`).
- **Fördröjning mellan studioreplikerna** — allt ljud förladdas nu och nästa replik klipper in strax innan förra tar slut, istället för en fast paus + fetch-fördröjning (`1392106`).
