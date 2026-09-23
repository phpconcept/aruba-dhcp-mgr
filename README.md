# Aruba DHCP Manager

Frontal web pour gérer le serveur DHCP de switchs HPE Aruba ArubaOS-Switch
(AOS-S), en particulier des 2930. Portage/réécriture des principes d'un
ancien outil PHP (`ArubaDhcpMgt`) vers FastAPI.

S'appuie sur la librairie [`aruba-aos-switch`](https://github.com/phpconcept/aruba-aos-switch)
pour parler à l'API REST des switchs — voir [`ARCHITECTURE.md`](ARCHITECTURE.md)
pour le détail des choix techniques.

## Fonctionnalités

- Connexion à un ou plusieurs switchs connus (`switches.yaml`), avec
  login/mot de passe demandés à chaque session — rien n'est jamais stocké
  sur disque. Une seule connexion active à la fois par session (se
  connecter à un switch déconnecte proprement les autres)
- Dashboard : ajout/suppression de switchs (mode carte), Connecter/
  Déconnecter par carte
- Fiche par switch (`/switches/<id>`) :
  - infos générales (nom/IP), boutons Connecter/Déconnecter/Supprimer
  - statut du serveur DHCP (activé/désactivé/indéterminé) avec bascule
    (confirmation à la désactivation, pas de bouton si statut indéterminé)
  - tableau des pools DHCP (lecture)
- Pools DHCP : liste, ajout, suppression, tri par IP
- Réservations statiques : liste, ajout, suppression (formulaire global,
  sans contrainte de sous-réseau), colonne Pool (lien direct pour les
  réservations dynamiques, déduit par sous-réseau pour les statiques),
  tri par IP
- Fiche détaillée par pool (`/pools/<name>`) :
  - passerelles/DNS/nom de domaine DNS/durée de bail éditables (bail vide
    = infinite)
  - plages d'adresses (ajout/suppression)
  - baux dynamiques actifs (lien fiable avec le pool)
  - réservations statiques du sous-réseau (détection informative par CIDR)
    avec ajout contraint (IP dans le sous-réseau du pool, masque du pool
    utilisé automatiquement) et suppression
- Validations à la création/édition (pool comme réservation) : IP/masque
  bien formés, MAC acceptée dans plusieurs notations et convertie au format
  switch, nom limité à 32 caractères alphanumériques/tirets et dérivé
  automatiquement si laissé vide (MAC+IP pour une réservation, IP pour un
  pool — pour limiter le risque d'écraser silencieusement une entrée
  existante, le nom étant la seule clé d'unicité côté switch), maximum 8
  passerelles et 8 DNS, durée de bail au format JJ:HH:MM
- Rafraîchissement manuel + horodatage de dernière mise à jour, sur les
  pages pools/réservations, la fiche pool et la fiche switch
- Modale de confirmation (libellé adaptable) pour les suppressions et la
  désactivation du serveur DHCP

Voir [`ARCHITECTURE.md`](ARCHITECTURE.md) pour le détail des choix, y
compris quelques comportements du switch à connaître (écrasement silencieux
sur un nom de pool réutilisé, pools sans réseau invisibles dans la liste,
lecture du domain-name uniquement via `show running-config`...).

## Prérequis

- Python 3.11+
- Un accès réseau en HTTPS vers l'API REST des switchs à gérer (voir
  [`ARCHITECTURE.md` §7](ARCHITECTURE.md#7-point-de-configuration-switch-à-connaître-troubleshooting)
  pour activer certificat/SSL/REST API côté switch)

## Installation

Deux modes, selon l'usage — le code est strictement le même, seule la
provenance d'`aruba-aos-switch` change.

### Dev

Co-développement avec [`aruba-aos-switch`](https://github.com/phpconcept/aruba-aos-switch),
cloné en dépôt frère (ex. sur Mowgli) :
```bash
git clone https://github.com/phpconcept/aruba-dhcp-mgr.git
cd aruba-dhcp-mgr
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```
`requirements.txt` installe `aruba-aos-switch` en editable depuis
`/var/dev/aruba-aos-switch` — adapter ce chemin dans le fichier si la lib
est clonée ailleurs. Toute modif de la lib est prise en compte
immédiatement, sans réinstall.

### Prod

Serveur dédié (ex. `/opt/aruba-dhcp-mgr` — voir
[`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-déploiement) pour la procédure
complète, utilisateur système compris), sans dossier source pour la lib :
```bash
sudo git clone git@github.com-aruba-dhcp-mgr:phpconcept/aruba-dhcp-mgr.git /opt/aruba-dhcp-mgr
cd /opt/aruba-dhcp-mgr
python3 -m venv .venv
.venv/bin/pip install -r requirements-prod.txt
sudo chown -R svc-dhcp-mgr:svc-dhcp-mgr /opt/aruba-dhcp-mgr
```
`requirements-prod.txt` récupère `aruba-aos-switch` directement depuis
GitHub, à une version taguée — nécessite une clé de déploiement SSH
(lecture seule) sur ce repo (voir `ARCHITECTURE.md` §6).

## Configuration

`switches.yaml` (nom + IP des switchs connus, aucun identifiant) **n'est
pas versionné** — il est créé automatiquement au premier ajout de switch
depuis le dashboard, pour qu'une mise à jour du code (`git pull`) n'écrase
jamais l'inventaire réel d'une instance. `switches-sample.yaml` (versionné)
sert de point de départ si besoin :

```bash
cp switches-sample.yaml switches.yaml
```

```yaml
switches:
  - id: switch-labo
    name: "Switch labo (2930)"
    host: "192.168.22.4"
```

Le plus simple reste de tout gérer depuis le dashboard une fois l'appli
lancée (ajout/suppression de switch).

## Lancement

### Manuel (dev, tests ponctuels)

```bash
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8002
```
Puis ouvrir `http://<host>:8002/`. S'arrête avec le terminal (ou en tâche
de fond via `nohup ... &`, mais sans redémarrage automatique).

### systemd (prod)

Une fois l'installation prod faite (voir plus haut) et l'unité
`deploy/aruba-dhcp-mgr.service` adaptée (IP du serveur à renseigner —
détail dans [`ARCHITECTURE.md` §6](ARCHITECTURE.md#6-déploiement)) :

```bash
sudo cp deploy/aruba-dhcp-mgr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aruba-dhcp-mgr
```

Gestion courante :
```bash
sudo systemctl status aruba-dhcp-mgr     # état du service
sudo systemctl restart aruba-dhcp-mgr    # après une mise à jour du code
sudo journalctl -u aruba-dhcp-mgr -f     # logs en direct
```

Démarre automatiquement au boot, redémarre seul en cas de plantage
(`Restart=on-failure`).

## Statut

Projet en développement actif, usage interne sur un LAN fermé — pas
d'authentification sur l'application elle-même.
