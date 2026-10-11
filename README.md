# Wegenwacht-site met Discord-login

Dezelfde website als eerder, maar nu op je eigen server met **echt inloggen via Discord**.
Alleen mensen die in jouw Discord-server zitten (en de juiste rol hebben) komen binnen.
Management is iedereen met een van de managementrollen. Er hoeft **geen bot** te draaien.

Wat nu anders is dan de versie in Claude:
- Geen "aanmelden" meer: bij de eerste login wordt automatisch een account gemaakt met hun Discord-bijnaam.
- Alle regels worden op de server gecontroleerd. Spelers kunnen dus niet hun eigen uren of rang aanpassen, en de vereiste uren per rang gaan nooit naar spelers toe.
- De promotie elke maandag draait echt op de server, ook als niemand de site opent.
- De gegevens staan in het bestand `data.sqlite` naast de server. Maak daar af en toe een kopie van.

## Wat je nodig hebt
- Een computer of server die altijd aan staat (een kleine VPS, of een hostingdienst waar je Node.js kunt draaien).
- Node.js **22.13 of nieuwer** (`node -v`). Er hoeft niets met npm geïnstalleerd te worden.
- Een eigen (sub)domein met https voor de echte site. Voor testen op je eigen pc werkt `http://localhost:3000`.

## Stap 1: Discord-applicatie maken
1. Ga naar https://discord.com/developers/applications en klik **New Application**.
2. Open links **OAuth2**.
3. Bij **Redirects** voeg je toe: `JOUW_BASE_URL/auth/callback`, bijvoorbeeld `https://wegenwacht.jouwdomein.nl/auth/callback` (of `http://localhost:3000/auth/callback` om te testen). Het moet precies kloppen. Sla op.
4. Kopieer de **Client ID**. Klik **Reset Secret** en kopieer de **Client Secret**. Deel die nooit.

## Stap 2: ID's uit Discord halen
Zet in Discord eerst **Ontwikkelaarsmodus** aan (Instellingen > Geavanceerd).
- **Server-ID:** rechtsklik op je server > Server-ID kopiëren.
- **Rol-ID's:** Serverinstellingen > Rollen > rechtsklik op een rol > Rol-ID kopiëren. Je hebt het ID nodig van de rol die leden hebben, en van de rol(len) voor management.

## Stap 3: instellen
1. Kopieer `.env.example` naar `.env`.
2. Vul alles in. Voor `SESSION_SECRET` verzin je een lange willekeurige tekst (minimaal 32 tekens).
3. `MEMBER_ROLE_ID`: alleen mensen met deze rol komen binnen. Laat je het leeg, dan komt iedereen in je Discord-server binnen.
4. `MANAGER_ROLE_IDS`: rollen die management zijn. Management komt altijd binnen, ook zonder de ledenrol.

## Stap 4: starten
```
npm start
```
Open daarna je `BASE_URL` in de browser. Je ziet een scherm met **Inloggen met Discord**.

Zorg dat het programma blijft draaien, bijvoorbeeld met `pm2`, `systemd` of de herstartfunctie van je hosting.
Voor https zet je er een reverse proxy voor, bijvoorbeeld Caddy:
```
wegenwacht.jouwdomein.nl {
    reverse_proxy localhost:3000
}
```

## Goed om te weten
- **Rollen:** wie inlogt blijft 12 uur ingelogd. Haal je iemand uit de server of pak je een rol af, dan werkt dat uiterlijk na 12 uur (of bij de volgende login).
- **Verwijderen:** een lid verwijderen in Leden beheren wist zijn uren. Zolang hij nog toegang heeft in Discord, wordt bij zijn volgende bezoek een nieuw account met 0 uur aangemaakt. Wil je iemand echt buitensluiten, haal hem dan uit de Discord-rol.
- **Bestaande uren overnemen** uit de versie in Claude gaat niet automatisch. Laat iedereen één keer inloggen en zet daarna de uren en rangen handmatig bij Leden beheren.
- **Testen:** `npm test` draait een complete test met een nagebootste Discord (login, toegang, rechten, klokken, promoties).
