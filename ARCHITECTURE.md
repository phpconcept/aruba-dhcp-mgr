# Architecture — Aruba DHCP Manager

Ce document résume les choix faits et l'implémentation, pour reprendre le
projet plus tard sans avoir à tout redécouvrir.

Dernière mise à jour : 22/09/2026 — après validation d'une connexion réelle
(pools + réservations) sur un switch de labo.

## 1. Objectif du projet

Frontal web pour configurer le serveur DHCP d'un switch **HPE Aruba
ArubaOS-Switch (AOS-S)**, en particulier un 2930. Portage/réécriture des
principes d'un ancien projet PHP (`ArubaDhcpMgt`, framework maison "pae/adm")
vers Python/FastAPI, hébergé sur **Mowgli** (`192.168.22.25`, Debian 13).

Le projet s'appuie sur la librairie séparée **`aruba-aos-switch`**
(`/var/dev/aruba-aos-switch`, voir son propre `DESIGN.md`), qui porte la
logique de connexion et les fonctions DHCP (`pool_list`, `pool_add`,
`binding_list`, ...). `aruba-dhcp-mgr` ne fait que l'habillage web ; les deux
projets sont volontairement séparés (repos distincts) pour que la lib reste
réutilisable par d'autres futurs projets (VLANs, interfaces...) sans traîner
de dépendance FastAPI/Jinja2.

## 2. Choix techniques et pourquoi

| Choix | Raison |
|---|---|
| **FastAPI + Jinja2 + Bootstrap 5** | Cohérent avec `inventory-dashboard`, plutôt que de reproduire à l'identique la stack de l'ancien PHP (w3.css/Bootstrap 3/jQuery) — validé avec Vincent. |
| **Aucune donnée persistée (pas de SQLite)** | Seul `switches.yaml` est sur disque (nom + IP des switchs connus, aucun secret). Cohérent avec le principe d'origine du PHP : les identifiants ne sont jamais stockés. |
| **Login/mot de passe redemandés à chaque session** | Popup de connexion (équivalent de la modale `server_select` du PHP) à chaque nouvelle session navigateur. |
| **Connexion switch gardée en mémoire process, pas en base** | `app/switch_session.py` : dict `{session_id: {switch_id: AosSwitchClient}}`. Un redémarrage du service déconnecte tout le monde — choix assumé, comme le "Restart Session" du PHP. |
| **Multi-switch dès la v1** | Le registre est à deux niveaux (session → switch_id → client) et `switches.yaml` liste plusieurs switchs possibles, pour éviter une V2 qui casserait ce modèle. |
| **Session cookie signé (`itsdangerous`/`SessionMiddleware`)** | Ne contient qu'un identifiant de session opaque (`sid`), jamais d'identifiants. Clé de signature régénérée à chaque démarrage du service (cohérent avec le fait que les connexions en mémoire ne survivent de toute façon pas à un redémarrage). |
| **Pas d'authentification sur l'appli elle-même** | Cohérent avec le reste de l'infra Mowgli (LAN fermé, mono-utilisateur), comme `inventory-dashboard`. |

## 3. Arborescence du projet

```
/var/dev/aruba-dhcp-mgr/
├── app/
│   ├── main.py              # point d'entrée FastAPI, SessionMiddleware
│   ├── config.py            # chargement de switches.yaml (nom/IP des switchs connus)
│   ├── switch_session.py    # registre en mémoire des connexions switch actives
│   ├── routers/
│   │   ├── web.py           # pages HTML : /, /pools, /bindings
│   │   └── api.py           # API JSON (JS) : connect/disconnect, lecture pools/bindings
│   └── templates/
│       ├── base.html        # layout commun (navbar, bandeau de connexion, modale connexion)
│       ├── dashboard.html
│       ├── pools.html
│       └── bindings.html
├── static/
│   ├── js/app.js             # connexion switch, chargement pools/bindings en AJAX
│   └── style.css
├── switches.yaml             # liste des switchs connus (nom, IP) — pas de secrets
├── deploy/                   # (à venir : unité systemd, cf. §6)
├── requirements.txt
├── .gitignore
└── ARCHITECTURE.md           # ce fichier
```

## 4. Modèle de connexion switch

- Chaque switch connu est déclaré dans `switches.yaml` (`id`, `name`, `host`).
- La popup "Se connecter à un switch" envoie `POST /api/switch/connect`
  `{switch_id, username, password}`. Le backend instancie un
  `AosSwitchClient(host, username, password)` et appelle `.login()` tout de
  suite pour valider les identifiants avant de considérer la session comme
  connectée.
- En cas d'échec (switch injoignable, identifiants refusés), l'exception
  `aruba_aos_switch.exceptions.AosSwitchError` est interceptée et son
  message renvoyé tel quel dans `{"ok": false, "error": "..."}`, affiché
  dans la popup — voir §7 pour le cas rencontré en pratique.
- Une fois connecté, `switch_id` devient le "switch courant" de la session
  (`request.session["current_switch_id"]`), affiché dans le bandeau
  vert/rouge en haut de page. Les pages Pools/Bindings interrogent ce switch
  courant.

## 5. Points d'accès

| Route | Méthode | Usage |
|---|---|---|
| `/` | GET | Dashboard : liste des switchs connus |
| `/pools` | GET | Page HTML : liste des pools DHCP du switch courant |
| `/bindings` | GET | Page HTML : liste des réservations DHCP du switch courant |
| `/api/switch/connect` | POST | Connexion à un switch (voir §4) |
| `/api/switch/disconnect` | POST | Déconnexion (logout switch + oubli du client en mémoire) |
| `/api/switch/status` | GET | `{connected: [...], current: ...}` pour la session en cours |
| `/api/pools` | GET | Liste JSON des pools DHCP (`?switch_id=...`) |
| `/api/bindings` | GET | Liste JSON des réservations DHCP (`?switch_id=...`) |
| `/docs` | GET | Documentation interactive Swagger (auto-générée par FastAPI) |

**État actuel (v1) : lecture seule.** `pool_add`/`pool_edit`/`pool_delete` et
`binding_add`/`binding_delete` existent déjà côté lib `aruba-aos-switch` mais
ne sont pas encore branchés côté web — prévu en itération suivante (voir §8).

## 6. Déploiement

**Pas encore fait.** Pour l'instant, lancé manuellement en `nohup` pour les
tests :
```bash
cd /var/dev/aruba-dhcp-mgr
.venv/bin/uvicorn app.main:app --host 192.168.22.25 --port 8002
```
Port `8002` retenu car `8000` (`jeedom-mcp-server`) et `8001`
(`inventory-dashboard`) sont déjà pris.

À faire quand le socle sera validé : utilisateur système dédié
(`svc-dhcp-mgr`, même schéma que `svc-dashboard` dans `inventory-dashboard`)
et unité systemd dans `deploy/aruba-dhcp-mgr.service`.

## 7. Point de configuration switch à connaître (troubleshooting)

⚠️ Lors du premier test sur un switch réel, la connexion échouait avec :
```
Impossible de joindre <ip> (POST login-sessions) :
HTTPSConnectionPool(...): Max retries exceeded ...
Failed to establish a new connection: [Errno 111] Connection refused
```
**Diagnostic** : `Connection refused` (pas un timeout) sur le port 443 =
rien n'écoute en HTTPS côté switch, pas un souci réseau/pare-feu. Vérifié en
testant les ports depuis Mowgli (`80` ouvert, `443` fermé) : le web
management HTTP était actif, mais pas HTTPS/le certificat/l'API REST.

**Résolu** en activant côté switch la configuration certificat + SSL + REST
API (management HTTPS). Une fois cette conf faite, connexion, lecture des
pools et des réservations fonctionnent bien.

**À faire plus tard** :

**Commandes CLI ArubaOS-Switch qui résolvent ce point** (à refaire sur tout
nouveau switch 2930 avant de pouvoir s'y connecter) :
```
# Création d'un certificat auto-signé
crypto pki identity-profile HTTPS-PROFILE subject common-name Sw-2930F-Access org Lab country FR
crypto pki enroll-self-signed certificate-name HTTPS-CERT

# Activation du management HTTPS
web-management ssl

# Activation de l'API REST
rest-interface
```
Vérification :
```
show web-management
```
doit indiquer `HTTPS Access : Enabled` (port SSL 443).

- Éventuellement, un petit outil/page de troubleshooting côté
  `aruba-dhcp-mgr` (ou dans la lib `aruba-aos-switch`) qui teste la
  joignabilité HTTPS/REST avant la tentative de login, et affiche un message
  ciblé ("HTTPS non actif sur le switch" plutôt que l'erreur `requests` brute)
  — utile si un jour d'autres switchs sont ajoutés avec le même défaut de
  config initiale.
- `AosSwitchClient` accepte déjà un paramètre `scheme` ("http"/"https") si
  jamais un switch ne peut pas avoir HTTPS activé — pas branché dans
  `switches.yaml` pour l'instant (ajout rapide si le besoin se présente).

## 8. Pistes pour la suite

- ✅ Ajout/suppression de pools DHCP (`pool_add`/`pool_delete`)
- ✅ Ajout/suppression de réservations DHCP (`binding_add`/`binding_delete`,
  suppression limitée aux réservations statiques — voir §9)
- Édition de pool existant (`pool_edit` déjà dispo côté lib, pas encore
  branché côté web — nécessaire pour la gestion des plages, voir §9)
- Déploiement propre : utilisateur système dédié + unité systemd (voir §6)
- Doc/outil de troubleshooting connexion switch (voir §7)
- Support `scheme: http` par switch dans `switches.yaml`, si un switch ne
  peut pas avoir HTTPS activé

## 9. Cas particuliers observés sur une config réelle

Relevé le 22/09/2026 sur un export `dhcp-server pool ...` du switch de labo
(une quinzaine de pools réels : VLAN classiques avec `network`/`range`,
réservations statiques via `static-bind`, gateways/DNS multiples
séparés par virgule). Deux points à traiter :

### 9.1 Pool incomplet (ex: `testrr`)

Un pool peut n'avoir qu'un `default-router`, sans `network`/`mask` :
```
dhcp-server pool "testrr"
   default-router "192.168.39.1"
   exit
```
Or `dhcp.pool_list()` **exclut explicitement** les pools sans
`network_ip`/`network_mask` (voir le commentaire dans `dhcp.py` — ce filtre
vient de la classe PHP d'origine, pensé pour les pools qui ne portent que des
réservations statiques via `static-bind`, comme `test6`/`test7`/`testvbia`
dans le relevé). Mais `testrr` n'a pas non plus de `static-bind` : c'est un
pool **incomplet/orphelin**, ni un réseau valide ni un porteur de
réservations. Aujourd'hui il est donc invisible dans `pool_list()`
**silencieusement**, sans distinction avec "n'existe pas".

**À traiter** :
- Décider du comportement voulu : afficher ces pools incomplets à part
  (avec un badge "configuration incomplète") plutôt que les faire
  disparaître silencieusement ? Ou les ignorer volontairement mais avec un
  avertissement visible côté dashboard ("N pools ignorés car incomplets") ?
- Vérifier si `any_cli("show dhcp-server config")` (plutôt que l'endpoint
  REST structuré) permettrait de les lister quand même, pour au moins les
  signaler.

### 9.2 Gestion des plages (`range`)

Confirmé sur le relevé réel : plusieurs plages par pool sont courantes
(`VLAN-38` a deux `range` distincts), et `dhcp.pool_list()` les remonte déjà
correctement (`DhcpPool.ip_ranges: list[IpRange]`) — donc la lecture (page
Pools actuelle) les affiche déjà bien.

Ce qui manque : la **création/modification** des plages depuis l'interface.
`pool_add()` ne prend pas de plage en paramètre (un pool tout juste créé n'a
donc pas de `range` tant qu'on ne le modifie pas). `pool_edit()` côté lib
sait déjà ajouter/retirer des plages (`ip_ranges_add`/`ip_ranges_remove`),
mais rien n'est branché côté web pour l'instant (voir §8).

**À traiter** :
- Formulaire d'édition de pool (page ou modale dédiée), avec gestion des
  plages en ajout/retrait — c'est le principal chaînon manquant pour que la
  V1 couvre les cas réels observés (`VLAN-31`, `VLAN-38`...).
- Décider si `pool_add()` doit accepter directement une première plage à la
  création (évite un aller-retour création puis édition immédiate) —
  nécessiterait un petit ajout côté lib `aruba-aos-switch`.
