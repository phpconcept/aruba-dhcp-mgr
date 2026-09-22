"""Endpoints JSON appelés en JS (fetch) : connexion switch, gestion pools/bindings."""
from __future__ import annotations

import ipaddress
import re
from dataclasses import asdict

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app import config, switch_session
from aruba_aos_switch import dhcp
from aruba_aos_switch.exceptions import AosSwitchError
from aruba_aos_switch.models import IpRange

router = APIRouter(prefix="/api")


def _session_id(request: Request) -> str:
    """Identifiant opaque de session, créé au premier accès si besoin."""
    if "sid" not in request.session:
        import uuid

        request.session["sid"] = uuid.uuid4().hex
    return request.session["sid"]


class ConnectPayload(BaseModel):
    switch_id: str
    username: str
    password: str


@router.post("/switch/connect")
def switch_connect(payload: ConnectPayload, request: Request):
    switch = config.get_switch(payload.switch_id)
    if switch is None:
        return {"ok": False, "error": "Switch inconnu."}

    sid = _session_id(request)
    try:
        switch_session.connect(sid, switch.id, switch.host, payload.username, payload.password)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}

    request.session["current_switch_id"] = switch.id
    return {"ok": True, "switch_id": switch.id, "switch_name": switch.name}


@router.post("/switch/disconnect")
def switch_disconnect(payload: dict, request: Request):
    sid = _session_id(request)
    switch_id = payload.get("switch_id")
    if switch_id:
        switch_session.disconnect(sid, switch_id)
        if request.session.get("current_switch_id") == switch_id:
            request.session.pop("current_switch_id", None)
    return {"ok": True}


@router.get("/switch/status")
def switch_status(request: Request):
    sid = _session_id(request)
    connected = switch_session.connected_switch_ids(sid)
    current = request.session.get("current_switch_id")
    return {"connected": connected, "current": current}


def _get_connected_client(request: Request, switch_id: str):
    sid = _session_id(request)
    return switch_session.get_client(sid, switch_id)


def _not_connected() -> dict:
    return {"ok": False, "error": "Non connecté à ce switch."}


# ----------------------------------------------------------------------
# Switchs connus (switches.yaml)
# ----------------------------------------------------------------------


class SwitchCreatePayload(BaseModel):
    name: str
    host: str


@router.post("/switches")
def switch_add(payload: SwitchCreatePayload):
    name = payload.name.strip()
    host = payload.host.strip()
    if not name or not host:
        return {"ok": False, "error": "Nom et adresse IP sont requis."}
    switch = config.add_switch(name, host)
    return {"ok": True, "switch": asdict(switch)}


@router.delete("/switches/{switch_id}")
def switch_remove(switch_id: str):
    if not config.remove_switch(switch_id):
        return {"ok": False, "error": "Switch introuvable."}
    return {"ok": True}


# ----------------------------------------------------------------------
# Switch — paramètres globaux
# ----------------------------------------------------------------------


@router.get("/switches/{switch_id}/dhcp-status")
def switch_dhcp_status(switch_id: str, request: Request):
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        enabled = dhcp.server_status(client)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    # enabled : True/False si déterminé, None si le format de sortie du
    # switch n'a pas été reconnu (voir dhcp.server_status()).
    return {"ok": True, "dhcp_enabled": enabled}


# ----------------------------------------------------------------------
# Pools DHCP
# ----------------------------------------------------------------------


@router.get("/pools")
def pools_list(switch_id: str, request: Request):
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        pools = dhcp.pool_list(client)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "pools": [asdict(p) for p in pools]}


class PoolPayload(BaseModel):
    switch_id: str
    name: str
    ip: str
    mask: str
    dns_servers: list[str] = []
    default_gateways: list[str] = []


@router.post("/pools")
def pool_add(payload: PoolPayload, request: Request):
    client = _get_connected_client(request, payload.switch_id)
    if client is None:
        return _not_connected()

    ip = payload.ip.strip()
    mask = payload.mask.strip() or "255.255.255.0"
    if not ip:
        return {"ok": False, "error": "L'adresse IP réseau est requise."}
    if not _valid_ipv4(ip):
        return {"ok": False, "error": f"Adresse IP réseau invalide : « {ip} »."}
    if not _valid_ipv4(mask):
        return {"ok": False, "error": f"Masque invalide : « {mask} »."}

    # Nom par défaut si non renseigné : l'IP réseau avec les « . » remplacés
    # par des « - » (déjà conforme à la contrainte alphanumérique + tiret).
    name = payload.name.strip() or ip.replace(".", "-")
    name_error = _validate_name(name)
    if name_error:
        return {"ok": False, "error": name_error}

    try:
        dhcp.pool_add(
            client,
            name,
            ip,
            mask,
            dns_servers=payload.dns_servers or None,
            default_gateways=payload.default_gateways or None,
        )
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@router.delete("/pools/{name}")
def pool_delete(name: str, switch_id: str, request: Request):
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        dhcp.pool_delete(client, name)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@router.get("/pools/{name}")
def pool_detail(name: str, switch_id: str, request: Request):
    """
    Fiche détaillée d'un pool : ses infos, les baux dynamiques actifs qu'il a
    distribués (lien fiable via binding.pool == name) et les réservations
    statiques dont l'IP tombe dans son réseau (lien calculé/best-effort :
    sur ArubaOS-Switch une réservation statique est un pool à part, sans
    lien structurel avec le pool réseau — voir ARCHITECTURE.md §9).
    """
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        pools = dhcp.pool_list(client)
        bindings = dhcp.binding_list(client)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}

    pool = next((p for p in pools if p.name == name), None)
    if pool is None:
        return {"ok": False, "error": f"Pool « {name} » introuvable (ou sans réseau défini)."}

    dynamic_bindings = [asdict(b) for b in bindings if b.type == "dynamic" and b.pool == name]

    static_bindings = []
    try:
        network = ipaddress.ip_network(f"{pool.ip}/{pool.mask}", strict=False)
        for b in bindings:
            if b.type != "static":
                continue
            try:
                if ipaddress.ip_address(b.ip) in network:
                    static_bindings.append(asdict(b))
            except ValueError:
                continue
    except ValueError:
        pass  # réseau/masque du pool non exploitables, on ignore le calcul

    return {
        "ok": True,
        "pool": asdict(pool),
        "dynamic_bindings": dynamic_bindings,
        "static_bindings": static_bindings,
    }


class PoolEditPayload(BaseModel):
    switch_id: str
    dns_servers: list[str] = []
    default_gateways: list[str] = []


@router.put("/pools/{name}")
def pool_edit(name: str, payload: PoolEditPayload, request: Request):
    client = _get_connected_client(request, payload.switch_id)
    if client is None:
        return _not_connected()
    try:
        dhcp.pool_edit(
            client,
            name,
            dns_servers=payload.dns_servers,
            default_gateways=payload.default_gateways,
        )
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


class RangePayload(BaseModel):
    switch_id: str
    ip_start: str
    ip_end: str


@router.post("/pools/{name}/ranges")
def pool_range_add(name: str, payload: RangePayload, request: Request):
    client = _get_connected_client(request, payload.switch_id)
    if client is None:
        return _not_connected()
    try:
        dhcp.pool_edit(
            client, name, ip_ranges_add=[IpRange(payload.ip_start, payload.ip_end)]
        )
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@router.delete("/pools/{name}/ranges")
def pool_range_delete(name: str, switch_id: str, ip_start: str, ip_end: str, request: Request):
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        dhcp.pool_edit(client, name, ip_ranges_remove=[IpRange(ip_start, ip_end)])
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def _valid_ipv4(value: str) -> bool:
    try:
        ipaddress.IPv4Address(value.strip())
        return True
    except ValueError:
        return False


_MAC_CLEAN_RE = re.compile(r"^[0-9A-F]{12}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9-]+$")
_NAME_MAX_LENGTH = 32  # limite ArubaOS-Switch sur le nom d'un pool DHCP


def _validate_name(name: str) -> str | None:
    """Nom d'un pool (réseau ou réservation statique — les deux sont des
    pools côté switch). Renvoie un message d'erreur si invalide, sinon
    None."""
    if not _NAME_RE.match(name):
        return f"Nom invalide : « {name} » (lettres, chiffres et tirets uniquement)."
    if len(name) > _NAME_MAX_LENGTH:
        return f"Nom trop long : « {name} » ({len(name)} caractères, {_NAME_MAX_LENGTH} max)."
    return None


def _normalize_mac(raw: str) -> tuple[str, str] | None:
    """
    Valide une adresse MAC en acceptant plusieurs notations courantes
    (AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, AABBCC-DDEEFF, ou 12 caractères
    hexa bruts). Renvoie (format_switch, format_affichage), ou None si la
    valeur n'est pas exploitable.

    Le format switch (« aabbcc-ddeeff ») est celui attendu tel quel par
    dhcp.binding_add() dans la commande CLI ArubaOS — la lib ne fait aucune
    conversion de son côté, c'est donc à l'appelant de fournir déjà le bon
    format.
    """
    cleaned = raw.strip().upper().replace(":", "").replace("-", "").replace(".", "")
    if not _MAC_CLEAN_RE.match(cleaned):
        return None
    switch_format = f"{cleaned[0:6]}-{cleaned[6:12]}".lower()
    display_format = ":".join(cleaned[i : i + 2] for i in range(0, 12, 2))
    return switch_format, display_format


# ----------------------------------------------------------------------
# Réservations (bindings) DHCP
# ----------------------------------------------------------------------


@router.get("/bindings")
def bindings_list(switch_id: str, request: Request):
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        bindings = dhcp.binding_list(client)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "bindings": [asdict(b) for b in bindings]}


class BindingPayload(BaseModel):
    switch_id: str
    name: str = ""
    mac: str
    ip: str
    ip_mask: str = ""


@router.post("/bindings")
def binding_add(payload: BindingPayload, request: Request):
    client = _get_connected_client(request, payload.switch_id)
    if client is None:
        return _not_connected()

    ip = payload.ip.strip()
    if not _valid_ipv4(ip):
        return {"ok": False, "error": f"Adresse IP invalide : « {payload.ip} »."}

    mac_formats = _normalize_mac(payload.mac)
    if mac_formats is None:
        return {"ok": False, "error": f"Adresse MAC invalide : « {payload.mac} »."}
    mac_switch_format, mac_display_format = mac_formats

    ip_mask = payload.ip_mask.strip() or "255.255.255.0"
    if not _valid_ipv4(ip_mask):
        return {"ok": False, "error": f"Masque invalide : « {payload.ip_mask} »."}

    # Nom du pool statique sous-jacent : ArubaOS-Switch n'accepte que
    # alphanumérique + tiret, et le nom est la seule clé d'unicité côté
    # switch (réutiliser un nom existant écrase silencieusement l'entrée,
    # voir ARCHITECTURE.md §9.4). Par défaut on concatène donc MAC (format
    # switch) et IP plutôt que la seule MAC, pour réduire le risque de
    # collision avec une réservation qu'on voudrait garder (deux réservations
    # pour un même équipement sur des IP différentes, par exemple).
    name = payload.name.strip() or f"{mac_switch_format}-{ip.replace('.', '-')}"
    name_error = _validate_name(name)
    if name_error:
        return {"ok": False, "error": name_error}

    try:
        dhcp.binding_add(client, name, mac_switch_format, ip, ip_mask)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@router.delete("/bindings/{name}")
def binding_delete(name: str, switch_id: str, request: Request):
    client = _get_connected_client(request, switch_id)
    if client is None:
        return _not_connected()
    try:
        dhcp.binding_delete(client, name)
    except AosSwitchError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}
