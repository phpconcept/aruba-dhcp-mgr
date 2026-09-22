"""Chargement/écriture de la liste des switchs connus (switches.yaml).

Ce fichier ne contient que des informations non sensibles (nom, IP). Les
identifiants de connexion ne sont jamais stockés ici : ils sont saisis par
l'utilisateur à chaque session (voir switch_session.py).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

SWITCHES_FILE = Path(__file__).resolve().parent.parent / "switches.yaml"

_HEADER = (
    "# Liste des switchs Aruba connus (nom + IP uniquement — jamais d'identifiants ici).\n"
    "# Le username/password sont demandés à chaque session via la popup de connexion.\n"
)


@dataclass
class SwitchConfig:
    id: str
    name: str
    host: str


def load_switches() -> list[SwitchConfig]:
    if not SWITCHES_FILE.exists():
        return []
    data = yaml.safe_load(SWITCHES_FILE.read_text()) or {}
    return [
        SwitchConfig(id=item["id"], name=item["name"], host=item["host"])
        for item in data.get("switches", [])
    ]


def get_switch(switch_id: str) -> SwitchConfig | None:
    for switch in load_switches():
        if switch.id == switch_id:
            return switch
    return None


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "switch"


def save_switches(switches: list[SwitchConfig]) -> None:
    data = {"switches": [{"id": s.id, "name": s.name, "host": s.host} for s in switches]}
    body = yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False)
    SWITCHES_FILE.write_text(_HEADER + body)


def add_switch(name: str, host: str) -> SwitchConfig:
    """Ajoute un switch, en dérivant un id (slug) unique à partir du nom."""
    switches = load_switches()
    existing_ids = {s.id for s in switches}
    base_slug = _slugify(name)
    slug = base_slug
    suffix = 2
    while slug in existing_ids:
        slug = f"{base_slug}-{suffix}"
        suffix += 1

    new_switch = SwitchConfig(id=slug, name=name, host=host)
    switches.append(new_switch)
    save_switches(switches)
    return new_switch


def remove_switch(switch_id: str) -> bool:
    switches = load_switches()
    remaining = [s for s in switches if s.id != switch_id]
    if len(remaining) == len(switches):
        return False
    save_switches(remaining)
    return True
