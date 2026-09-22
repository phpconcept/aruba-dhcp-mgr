"""Registre en mémoire des connexions switch actives.

Principe repris de l'ancien ArubaDhcpMgt (PHP) : aucun identifiant n'est
jamais stocké sur disque. Le cookie de session (signé, géré par
SessionMiddleware) ne contient qu'un identifiant de session opaque ; les
objets `AosSwitchClient` connectés (qui portent le cookie de session côté
switch) vivent uniquement en mémoire du process, associés à cet identifiant.

Un redémarrage du service déconnecte tout le monde (comme un "Restart
Session" côté PHP) — c'est un choix assumé, pas une lacune.

Le registre est à deux niveaux (session -> switch_id -> client) pour
permettre plusieurs switchs connus (`switches.yaml`), mais **une seule
connexion active à la fois par session** : se connecter à un nouveau switch
déconnecte proprement les autres. Modèle plus simple, sans connexions
"oubliées" en arrière-plan (le multi-switch simultané avait été envisagé au
départ, mais s'est avéré plus source de confusion que de souplesse à
l'usage — voir ARCHITECTURE.md).
"""
from __future__ import annotations

import threading

from aruba_aos_switch import AosSwitchClient
from aruba_aos_switch.exceptions import AosSwitchError

# {session_id: {switch_id: AosSwitchClient}}
_connections: dict[str, dict[str, AosSwitchClient]] = {}
_lock = threading.Lock()


def connect(session_id: str, switch_id: str, host: str, username: str, password: str) -> None:
    """Se connecte à un switch et l'enregistre pour cette session.

    Une seule connexion active à la fois par session : les connexions à
    d'autres switchs pour cette même session sont fermées avant d'établir
    la nouvelle (voir docstring du module).

    Lève AuthenticationError / ConnectionError (voir aruba_aos_switch.exceptions)
    si la connexion échoue — l'appelant (route API) les traduit en message
    d'erreur affiché dans la popup, rien n'est enregistré/déconnecté dans ce
    cas (on ne ferme les autres qu'une fois la nouvelle connexion validée).
    """
    client = AosSwitchClient(host, username, password)
    client.login()  # lève immédiatement si les identifiants sont refusés

    with _lock:
        other_ids = [sid for sid in _connections.get(session_id, {}) if sid != switch_id]
    for other_id in other_ids:
        disconnect(session_id, other_id)

    with _lock:
        _connections.setdefault(session_id, {})[switch_id] = client


def disconnect(session_id: str, switch_id: str) -> None:
    with _lock:
        client = _connections.get(session_id, {}).pop(switch_id, None)
    if client is not None:
        try:
            client.logout()
        except AosSwitchError:
            pass  # comme côté lib : un logout qui échoue n'est jamais bloquant


def get_client(session_id: str, switch_id: str) -> AosSwitchClient | None:
    return _connections.get(session_id, {}).get(switch_id)


def connected_switch_ids(session_id: str) -> list[str]:
    return list(_connections.get(session_id, {}).keys())


def disconnect_all(session_id: str) -> None:
    for switch_id in list(_connections.get(session_id, {}).keys()):
        disconnect(session_id, switch_id)
