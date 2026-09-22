"""Chargement de la liste des switchs connus (switches.yaml).

Ce fichier ne contient que des informations non sensibles (nom, IP). Les
identifiants de connexion ne sont jamais stockés ici : ils sont saisis par
l'utilisateur à chaque session (voir switch_session.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

SWITCHES_FILE = Path(__file__).resolve().parent.parent / "switches.yaml"


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
