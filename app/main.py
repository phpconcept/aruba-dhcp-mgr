"""Point d'entrée FastAPI — Aruba DHCP Manager."""
import secrets

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.routers import api, web

app = FastAPI(title="Aruba DHCP Manager")

# Clé de session générée à chaque démarrage : cohérent avec le choix de ne
# rien persister (un redémarrage du service invalide de toute façon les
# connexions switch en mémoire, voir switch_session.py).
app.add_middleware(SessionMiddleware, secret_key=secrets.token_hex(32))

app.include_router(web.router)
app.include_router(api.router)
app.mount("/static", StaticFiles(directory="static"), name="static")
