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
  sur disque
- Ajout/suppression de switchs depuis le dashboard (mode carte)
- Pools DHCP : liste, ajout, suppression
- Réservations statiques : liste, ajout, suppression (formulaire global,
  sans contrainte de sous-réseau)
- Fiche détaillée par pool (`/pools/<name>`) :
  - passerelles/DNS éditables
  - plages d'adresses (ajout/suppression)
  - baux dynamiques actifs (lien fiable avec le pool)
  - réservations statiques du sous-réseau (détection informative par CIDR)
    avec ajout contraint (IP dans le sous-réseau du pool, masque du pool
    utilisé automatiquement) et suppression
- Validations à la création (pool comme réservation) : IP/masque bien
  formés, nom limité à 32 caractères alphanumériques/tirets (limite
  switch), nom par défaut dérivé automatiquement si laissé vide
- Rafraîchissement manuel + horodatage de dernière mise à jour, sur les
  pages pools/réservations et sur la fiche pool

Voir [`ARCHITECTURE.md`](ARCHITECTURE.md) pour le détail des choix, y
compris quelques comportements du switch à connaître (écrasement silencieux
sur un nom de pool réutilisé, pools sans réseau invisibles dans la liste...).

## Prérequis

- Python 3.11+
- Un accès réseau en HTTPS vers l'API REST des switchs à gérer (voir
  [`ARCHITECTURE.md` §7](ARCHITECTURE.md#7-point-de-configuration-switch-à-connaître-troubleshooting)
  pour activer certificat/SSL/REST API côté switch)

## Installation

```bash
git clone https://github.com/phpconcept/aruba-dhcp-mgr.git
cd aruba-dhcp-mgr
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`requirements.txt` installe `aruba-aos-switch` en editable depuis
`/var/dev/aruba-aos-switch` — adapter ce chemin si la lib est clonée
ailleurs.

## Configuration

Éditer `switches.yaml` pour déclarer les switchs connus (nom + IP
uniquement, aucun identifiant) :

```yaml
switches:
  - id: switch-labo
    name: "Switch labo (2930)"
    host: "192.168.22.4"
```

Ça peut aussi se faire depuis le dashboard une fois l'appli lancée.

## Lancement

```bash
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8002
```

Puis ouvrir `http://<host>:8002/`.

## Statut

Projet en développement actif, usage interne sur un LAN fermé — pas
d'authentification sur l'application elle-même.
