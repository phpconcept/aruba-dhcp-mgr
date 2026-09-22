"""Pages HTML : dashboard, pools, bindings."""
from __future__ import annotations

import json
from dataclasses import asdict

from fastapi import APIRouter, Request
from fastapi.templating import Jinja2Templates

from app import config

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")


def _base_context() -> dict:
    switches = config.load_switches()
    return {
        "switches": switches,
        "switches_json": json.dumps([asdict(s) for s in switches]),
    }


@router.get("/")
def dashboard(request: Request):
    context = _base_context() | {"active_page": "dashboard"}
    return templates.TemplateResponse(request=request, name="dashboard.html", context=context)


@router.get("/pools")
def pools_page(request: Request):
    context = _base_context() | {"active_page": "pools"}
    return templates.TemplateResponse(request=request, name="pools.html", context=context)


@router.get("/bindings")
def bindings_page(request: Request):
    context = _base_context() | {"active_page": "bindings"}
    return templates.TemplateResponse(request=request, name="bindings.html", context=context)


@router.get("/pools/{name}")
def pool_detail_page(name: str, request: Request):
    context = _base_context() | {"active_page": "pools", "pool_name": name}
    return templates.TemplateResponse(request=request, name="pool_detail.html", context=context)


@router.get("/switches/{switch_id}")
def switch_detail_page(switch_id: str, request: Request):
    switch = config.get_switch(switch_id)
    context = _base_context() | {
        "active_page": "dashboard",
        "switch_id": switch_id,
        "switch": switch,
    }
    return templates.TemplateResponse(request=request, name="switch_detail.html", context=context)
