"""Endpoints JSON appelés en JS (fetch) : connexion switch, gestion pools/bindings."""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app import config, switch_session
from aruba_aos_switch import dhcp
from aruba_aos_switch.exceptions import AosSwitchError

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
    try:
        dhcp.pool_add(
            client,
            payload.name,
            payload.ip,
            payload.mask,
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
    name: str
    mac: str
    ip: str
    ip_mask: str


@router.post("/bindings")
def binding_add(payload: BindingPayload, request: Request):
    client = _get_connected_client(request, payload.switch_id)
    if client is None:
        return _not_connected()
    try:
        dhcp.binding_add(client, payload.name, payload.mac, payload.ip, payload.ip_mask)
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
