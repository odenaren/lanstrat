# TODO — DHS Playbook

Ostrukturerad att-göra-lista. Uppdatera i klartext när nya idéer dyker upp eller när något är klart (flytta till "Klart" eller ta bort).

## Aktuellt

- **Streaming av strategitext** — visa AI-svaret i realtid medan det genereras istället för att vänta på hela svaret innan något visas.

## Framtid — inte aktuellt nu

- **Single player-läge.** Ett läge för den som spelar pubmatcher själv (inte på LAN) och vill ha samma typ av kul: roliga utmaningar, "produktion" (typ hype/recap) och statistik på sina egna matcher. Kräver eftertanke kring datamodell (separat från lag-matcherna) och vad som är rimligt att generera per-match för en enda spelare. Inget att bygga just nu — bara idé att inte tappa bort.

## Klart (flyttat hit vid färdigställande, för spårbarhet)

- **PIN-skydd för Strats/Historik** — löstes istället genom att bygga en separat `pool.html`-sida (egen JSONBin-bin) som spelarna kunde nå inför lanet utan att se Strats/Historik. Inte aktuellt längre efter lanet.
- **Hjältporträtt i historiklistan** — använder `heroImgByName` konsekvent med fallback-ikon när bild saknas.
