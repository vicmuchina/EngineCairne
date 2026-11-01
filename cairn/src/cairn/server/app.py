from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from cairn import __version__
from cairn.server import chat_runtime, db, pi_rpc
from cairn.server.routers import (
    approvals,
    chat,
    domain,
    export,
    hints,
    intents,
    projects,
    report,
    sessions,
    settings,
    steering,
    workers,
)

STATIC_DIR = Path(__file__).parent / "static"
LOG = logging.getLogger("cairn.server")


def _warn_multi_worker() -> None:
    """RPC sessions and the turn registry are in-process: one worker only."""
    workers = os.environ.get("CAIRN_SERVER_WORKERS") or os.environ.get("WEB_CONCURRENCY")
    if workers and workers.strip() not in ("", "1"):
        LOG.warning(
            "CAIRN_SERVER_WORKERS=%s: chat RPC sessions and the live-turn registry are "
            "per-process. Run uvicorn with --workers 1 or conversations will be split "
            "across processes and stop/steer will miss.",
            workers,
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.configure(db.DEFAULT_DB)
    _warn_multi_worker()
    # Before serving: kill orphan pi processes from a previous incarnation, replay any
    # JSONL they left behind, and close the stale chat_runs rows.
    try:
        summary = chat_runtime.reap_stale_runs()
        if summary["runs"]:
            LOG.warning(
                "reaped stale chat runs runs=%s killed_pids=%s replayed_lines=%s "
                "skipped_recycled_pids=%s",
                summary["runs"],
                summary["killed"],
                summary["replayed"],
                summary["skipped_pids"],
            )
    except Exception:  # pragma: no cover - a sweep failure must not stop the server
        LOG.exception("stale chat run sweep failed")
    pi_rpc.manager().start_reaper()
    try:
        yield
    finally:
        await chat_runtime.shutdown_all()


app = FastAPI(
    title="Cairn",
    description="Fact-graph based collaborative exploration protocol",
    version=__version__,
    lifespan=lifespan,
)

app.include_router(settings.router)
app.include_router(projects.router)
app.include_router(hints.router)
app.include_router(intents.router)
app.include_router(steering.router)
app.include_router(approvals.router)
app.include_router(export.router)
app.include_router(chat.router)
app.include_router(workers.router)
app.include_router(domain.router)
app.include_router(sessions.router)
app.include_router(report.router)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
