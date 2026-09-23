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
| **`switches.yaml` non versionné** | C'est un état runtime (l'inventaire réel de switchs d'une instance), pas du code — versionné, une mise à jour du dépôt l'écraserait avec l'exemple. `switches-sample.yaml` (versionné) sert de modèle ; `switches.yaml` (gitignore) est créé automatiquement par `config.save_switches()` au premier ajout de switch depuis le dashboard. |
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
├── switches-sample.yaml      # exemple versionné (voir §6 / .gitignore)
├── switches.yaml              # état réel, NON versionné — créé au 1er ajout de switch
├── deploy/aruba-dhcp-mgr.service  # unité systemd, cf. §6
├── requirements.txt           # dev (install éditable d'aruba-aos-switch)
├── requirements-prod.txt      # prod (aruba-aos-switch figé depuis GitHub)
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

**Dev (Mowgli), pas encore fait pour la prod.** Pour l'instant, lancé
manuellement en `nohup` pour les tests :
```bash
cd /var/dev/aruba-dhcp-mgr
.venv/bin/uvicorn app.main:app --host 192.168.22.25 --port 8002
```
Port `8002` retenu car `8000` (`jeedom-mcp-server`) et `8001`
(`inventory-dashboard`) sont déjà pris.

### Dépendance à `aruba-aos-switch` : dev vs prod

La prod tournera sur un **serveur distinct de Mowgli**. Décision (validée
avec Vincent) : pas de dossier `lib/`/`3rdparty/` dédié — la distinction
dev/prod se fait par le fichier de requirements utilisé, pip gère le reste
nativement :

- **`requirements.txt`** (dev, sur Mowgli) : install éditable du dépôt
  frère `/var/dev/aruba-aos-switch` (`-e /var/dev/aruba-aos-switch`) — les
  deux projets se développent en parallèle, toute modif de la lib est prise
  en compte immédiatement dans `aruba-dhcp-mgr` sans réinstall.
- **`requirements-prod.txt`** (nouveau, pour le serveur de prod) :
  `aruba-aos-switch` récupéré depuis GitHub à une **version taguée**
  (`aruba-aos-switch @ git+ssh://git@github.com/phpconcept/aruba-aos-switch.git@v0.1.0`)
  plutôt qu'en éditable — figé, reproductible, découplé de ce qui est en
  cours de dev sur Mowgli. Pas de dossier source à gérer sur le serveur de
  prod : pip clone et installe directement dans le venv.

Ce découpage évite un `.git` imbriqué dans l'arborescence d'un autre projet
(fragile avec certains outils, risque qu'un `git add -A` malheureux
échappe au `.gitignore`) tout en gardant `aruba-aos-switch` publiable et
réutilisable par d'éventuels futurs projets, en dépôt frère indépendant.

**Pourquoi `git+ssh://` et pas `git+https://`** : le dépôt est privé.
`https://` demanderait un identifiant/PAT au moment de l'install (pas
automatisable proprement) ; `ssh://` s'appuie sur une **clé de déploiement
dédiée** (deploy key GitHub, lecture seule, à ajouter uniquement sur ce
repo) configurée sur le serveur de prod — pas de token à gérer/faire
tourner.

**À faire pour que la prod fonctionne** (une fois le serveur choisi) :
1. Générer une paire de clés SSH sur le serveur de prod, ajouter la
   publique comme *deploy key* (lecture seule) sur
   `github.com/phpconcept/aruba-aos-switch` (et sur
   `aruba-dhcp-mgr` lui-même, pour le `git clone` initial du serveur).
2. `git clone` de `aruba-dhcp-mgr` sur le serveur de prod, puis
   `pip install -r requirements-prod.txt` dans un venv dédié.
3. À chaque nouvelle version de `aruba-aos-switch` qu'on veut pousser en
   prod : tag GitHub (`git tag vX.Y.Z && git push --tags`), mettre à jour
   la référence de tag dans `requirements-prod.txt`, réinstaller sur le
   serveur de prod.

### Unité systemd (`deploy/aruba-dhcp-mgr.service`)

✅ Préparée, même sans serveur cible choisi — reprend le schéma de
`inventory-dashboard`/`svc-dashboard` (utilisateur système dédié,
durcissement `ProtectSystem=strict` + `ReadWritePaths` limité à
`switches.yaml`, seul fichier modifié à l'exécution).

**Reste à faire une fois le serveur de prod choisi/accessible :**
1. Remplacer `<IP_SERVEUR_PROD>` dans le fichier `.service` par l'IP LAN
   réelle du serveur (convention : bind sur l'IP explicite, pas `0.0.0.0`,
   comme les autres services).
2. Créer l'utilisateur système dédié :
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin svc-dhcp-mgr
   ```
3. Générer la clé de déploiement SSH sur ce serveur, l'ajouter comme
   *deploy key* (lecture seule) sur `aruba-dhcp-mgr` et `aruba-aos-switch`
   (voir section précédente).
4. `git clone` de `aruba-dhcp-mgr` dans `/opt/aruba-dhcp-mgr` — convention
   FHS pour ce type d'appli auto-contenue (pas gérée par le paquet de la
   distro), distincte de `/var/www`/`/srv` réservés aux vhosts Apache
   classiques (PHP) sur ce serveur. Créer le venv et installer
   `requirements-prod.txt` :
   ```bash
   sudo git clone https://github.com/phpconcept/aruba-dhcp-mgr.git /opt/aruba-dhcp-mgr
   cd /opt/aruba-dhcp-mgr
   python3 -m venv .venv
   .venv/bin/pip install -r requirements-prod.txt
   sudo chown -R svc-dhcp-mgr:svc-dhcp-mgr /opt/aruba-dhcp-mgr
   ```
5. Installer et activer le service :
   ```bash
   sudo cp deploy/aruba-dhcp-mgr.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now aruba-dhcp-mgr
   ```
6. Vérifier : `sudo systemctl status aruba-dhcp-mgr`, et que
   `switches.yaml` reste bien modifiable (test ajout/suppression de switch
   depuis le dashboard) malgré `ProtectSystem=strict`.

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

- ✅ Fiche switch (`/switches/<id>`) : infos générales (nom/IP), statut
  enable/disable du serveur DHCP avec bascule (confirmation à la
  désactivation, pas de bouton si statut indéterminé), tableau des pools —
  voir §9.5 pour la fiabilité du parsing du statut
- ✅ Fiche pool : nom de domaine DNS et durée de bail (`domain-name`/
  `lease`, vide = infinite). La lecture du `domain_name` s'est avérée non
  exposée ni par le REST ni par `show dhcp-server pool <name>` (confirmé
  sur switch réel) — résolu via `dhcp.pool_domain_name()`, qui parse
  `show running-config` (testé avec un extrait de config réel fourni par
  Vincent). Appel ponctuel sur la fiche d'un pool, volontairement pas
  intégré à `pool_list()` (coût d'un `show running-config` complet à ne
  pas payer en boucle sur toute la liste).
- ✅ Ajout/suppression de pools DHCP (`pool_add`/`pool_delete`)
- ✅ Ajout/suppression de réservations DHCP (`binding_add`/`binding_delete`,
  suppression limitée aux réservations statiques — voir §9)
- ✅ Fiche/édition de pool (`/pools/<name>`) : passerelles, DNS, plages
  (ajout/suppression), baux dynamiques liés, réservations statiques
  détectées dans le sous-réseau — voir §9.3 pour le détail des choix
- ✅ Bouton rafraîchir + horodatage "dernière mise à jour" (pools,
  bindings, fiche pool) ; modale de confirmation (remplace `confirm()`)
  pour les suppressions
- Édition du réseau/masque d'un pool (`pool_edit` le permet côté lib,
  volontairement pas exposé côté web pour l'instant — changer le réseau
  d'un pool existant a plus de risques d'effets de bord que
  gateway/DNS/ranges, à ne pas faire sans y réfléchir)
- Cas des pools incomplets (`testrr`) — décision encore à prendre, voir §9.1
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

### 9.3 Fiche/édition de pool — choix retenus

Suite à discussion : la gestion des plages se fait **uniquement en
édition**, jamais à la création d'un pool (risque identifié : mélanger les
deux incite à sauter l'étape "vérifier les réservations statiques déjà
présentes avant d'ouvrir une plage").

Ça a mené à fusionner "fiche descriptive" et "écran d'édition" en une seule
page `/pools/<name>` (plutôt qu'une popup, ou deux écrans séparés) :
- Passerelles/DNS éditables inline (`PUT /api/pools/<name>`)
- Plages : ajout/suppression (`POST`/`DELETE /api/pools/<name>/ranges`)
- Baux dynamiques actifs : lien **fiable**, via `binding.pool == pool.name`
  (le switch groupe déjà `show dhcp-server binding` par pool)
- Réservations statiques "dans ce sous-réseau" : lien **calculé/best-effort**
  (IP de la réservation testée dans le CIDR réseau/masque du pool), car sur
  ArubaOS-Switch chaque réservation statique est un pool à part entière
  (`static-bind`), sans lien structurel avec le pool réseau — voir l'exemple
  réel `VLAN-31-a` (masque `/26`) vs `VLAN-31` (masque `/24`) au §9. Section
  clairement étiquetée comme informative dans l'UI, pas comme une vérité du
  switch.
- Réseau/masque du pool volontairement non éditables depuis cette page (voir
  §8).

### 9.4 Le nom de pool est la seule clé — écrasement silencieux si réutilisé

Observé en usage réel : côté switch, **le nom du pool est le seul
identifiant unique**. Conséquences constatées :

- **Même nom réutilisé** → écrase l'entrée existante (nouvelle IP/MAC,
  nouveau réseau...), **sans aucun avertissement côté switch**. Parfois
  voulu (corriger une entrée), parfois une erreur de saisie qui écrase
  silencieusement une réservation existante.
- **Noms différents, IP/MAC différentes, pools différents** → crée bien deux
  entrées distinctes. Cohérent, et c'est ce qui permet la souplesse
  actuelle (plusieurs réservations statiques indépendantes).
- **Noms différents, mais même IP/MAC réutilisée dans le même pool** →
  remplace l'ancienne entrée par la nouvelle (comportement attendu, le
  switch ne duplique pas une réservation sur la même IP).

**Piste d'amélioration à trancher plus tard** : faut-il ajouter un
avertissement/une confirmation côté appli quand le nom saisi (à l'ajout
d'un pool ou d'une réservation) correspond à un pool déjà existant sur le
switch, pour éviter un écrasement accidentel ? Aujourd'hui rien ne le
signale ni côté switch ni côté `aruba-dhcp-mgr` — à la charge de
l'utilisateur de vérifier avant de valider.

### 9.5 Fiche switch et paramètres DHCP globaux

Nouvelle page `/switches/<id>` (lien depuis le nom du switch sur les cartes
du dashboard), pensée pour grandir progressivement :
- Une partie **fixe/descriptive** (nom, IP — depuis `switches.yaml`)
- Une partie **paramètres DHCP globaux**, appelée à s'enrichir au fil de
  l'eau (options DHCP, etc.). Contient pour l'instant uniquement le statut
  enable/disable du serveur DHCP, en lecture seule.

**Fiabilité** : contrairement à `pool_list()` (REST structuré), il n'y a pas
d'endpoint REST connu pour ce statut. `dhcp.server_status()` côté lib
`aruba-aos-switch` parse le texte de `show dhcp-server` (même réserve que
`binding_list()` sur la sensibilité au firmware) — mais le motif a été
**validé sur la sortie réelle** de deux switchs (un DHCP désactivé, un
activé) :
```
 Configuration and Status - DHCP Server

  DHCP Server Enabled       : Yes
  DHCPv4 Operational Status : Enabled
  Traps Enabled             : Yes
  Persistent Lease Database : No
  Conflict Logging Enabled  : No
  DHCP VLAN Interfaces      : 31,32
```
`server_status()` s'appuie sur « DHCP Server Enabled » (le champ qui
correspond aux commandes `dhcp-server enable`/`disable`).

**Champs disponibles dans cette même sortie, pas encore exploités** —
pistes pour la suite :
- `DHCP VLAN Interfaces` : liste des VLAN sur lesquels le serveur DHCP est
  actif (ex. `31,32`) — sujet identifié comme intéressant à traiter, pas
  encore priorisé
- `DHCPv4 Operational Status` : statut opérationnel (peut différer du
  statut administratif si configuré mais sans interface VLAN active, par
  exemple)
- `Persistent Lease Database`, `Conflict Logging Enabled`, `Traps Enabled`

**Aussi à faire plus tard** : une fois un besoin clair identifié, envisager
une action pour basculer enable/disable depuis cette page (actuellement en
lecture seule uniquement). Egalement disponible côté CLI switch :
`show dhcp-server binding`/`conflicts`/`database`/`statistics` — pas
explorés pour l'instant.
