from __future__ import annotations

"""Persistent ``pi --mode rpc`` sessions for Cairn chat conversations.

One long-lived pi process per conversation, driven over newline-delimited JSON on
stdin/stdout. This is what makes live mid-turn steering possible: with ``pi --mode json
-p`` stdin is closed and the only lever is killing the process.

Protocol rules implemented here (see pi docs/rpc.md, docs/rpc-commands.md, docs/json.md):

* **Framing** — binary stdout is split on ``LF`` only. A line is decoded as UTF-8 *after*
  framing, so multi-byte characters can never be cut in half by a read boundary and
  ``U+2028``/``U+2029`` inside a JSON string are not treated as record separators.
* **Correlation** — every command carries a unique ``id``; ``response`` records are matched
  by id (pi handles commands asynchronously, so response order is not command order).
* **Turn completion** — ``agent_settled``, not ``agent_end``: retries, compaction recovery,
  steering and follow-ups can all continue after ``agent_end``.
* **Abort** — ``abort`` answers ``success`` without promising an event; an aborted turn is
  resolved by ``agent_settled{aborted:true}`` *or* by ``get_state.isStreaming == false``
  once an abort was sent. The queue is cleared before aborting, so pi cannot continue with
  a queued steer/follow-up inside the aborted turn.
* **Extension UI** — dialog requests are answered with ``cancelled`` so a headless RPC
  session can never block on a UI prompt.

The manager owns process lifecycle: warm reuse, an idle cap, an LRU cap, crash recovery and
shutdown of the whole process group. It is in-process state, so the server must run with
``--workers 1`` (documented in RUNTIME-V3.md and asserted by ``app.py``).
"""

import asyncio
import codecs
import json
import os
import signal
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from cairn.server import chat_runtime

READ_CHUNK = 65536
TERM_GRACE_SECONDS = 5.0
DEFAULT_IDLE_SECONDS = 900.0
DEFAULT_MAX_SESSIONS = 8
DEFAULT_COMMAND_TIMEOUT = 30.0
DEFAULT_STEER_TIMEOUT = 20.0
DEFAULT_STARTUP_TIMEOUT = 120.0
REAP_INTERVAL_SECONDS = 30.0

DIALOG_METHODS = frozenset({"select", "confirm", "input", "editor"})

# Wait outcome for one turn.
SETTLED = "settled"
ABORTED = "aborted"
TIMED_OUT = "timeout"
CRASHED = "crashed"


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def idle_seconds() -> float:
    return _env_float("CAIRN_CHAT_RPC_IDLE_SECONDS", DEFAULT_IDLE_SECONDS)


def max_sessions() -> int:
    return _env_int("CAIRN_CHAT_RPC_MAX_SESSIONS", DEFAULT_MAX_SESSIONS)


def steer_timeout() -> float:
    return _env_float("CAIRN_CHAT_STEER_TIMEOUT", DEFAULT_STEER_TIMEOUT)


class RpcError(RuntimeError):
    pass


@dataclass
class RpcResponse:
    id: str
    command: str
    success: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.success

    @property
    def disposition(self) -> str | None:
        value = self.data.get("disposition")
        return value if isinstance(value, str) else None


@dataclass
class RpcTurnOutcome:
    settle: str
    text: str
    error: str | None = None
    exit_code: int | None = None
    stderr_tail: str = ""
    disposition: str | None = None


class PiRpcSession:
    """One ``pi --mode rpc`` process and its JSONL protocol plumbing."""

    def __init__(
        self,
        *,
        conversation_id: int,
        project_id: str,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
        stderr_path: Path,
    ) -> None:
        self.conversation_id = conversation_id
        self.project_id = project_id
        self.argv = argv
        self.cwd = cwd
        self.env = env
        self.stderr_path = stderr_path
        self.proc: asyncio.subprocess.Process | None = None
        self.pid: int | None = None
        self.started_at = time.monotonic()
        self.last_used = time.monotonic()
        self.transport_errors: list[str] = []
        self.orphan_responses: list[dict[str, Any]] = []

        self._reader: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._sink: Callable[[dict[str, Any]], None] | None = None
        self._settled = asyncio.Event()
        self._closed = asyncio.Event()
        self._abort_sent = False
        self._settled_aborted = False
        self._closing = False
        self._write_lock = asyncio.Lock()
        # Messages pi still had queued when an abort cleared the queue (recorded as dropped
        # by the turn so a "queued" steering row is not left implying delivery).
        self.last_cleared: list[str] = []

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        self.stderr_path.parent.mkdir(parents=True, exist_ok=True)
        self.cwd.mkdir(parents=True, exist_ok=True)
        self._stderr_file = open(self.stderr_path, "ab")
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.argv,
                cwd=str(self.cwd),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=self._stderr_file,
                start_new_session=True,
                env=self.env,
            )
        except BaseException:
            self._stderr_file.close()
            raise
        self.pid = self.proc.pid
        self._reader = asyncio.create_task(self._read_loop())

    @property
    def alive(self) -> bool:
        return (
            self.proc is not None
            and self.proc.returncode is None
            and not self._closed.is_set()
        )

    def stderr_tail(self, limit: int = 4_000) -> str:
        try:
            data = self.stderr_path.read_bytes()
        except OSError:
            return ""
        return data[-limit:].decode("utf-8", errors="replace")

    # ------------------------------------------------------------------ reader
    async def _read_loop(self) -> None:
        """Read stdout continuously; split records on LF only.

        Reading must never stop: pi honours stdout backpressure, so a stalled reader
        eventually stalls the whole agent.
        """
        assert self.proc is not None and self.proc.stdout is not None
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buffer = ""
        try:
            while True:
                chunk = await self.proc.stdout.read(READ_CHUNK)
                if not chunk:
                    break
                # Bytes -> text happens once, incrementally: a chunk can end in the middle
                # of a multi-byte sequence, and a generic line reader would split on
                # U+2028/U+2029. Framing on LF is the only record boundary.
                buffer += decoder.decode(chunk)
                while "\n" in buffer:
                    line, _, buffer = buffer.partition("\n")
                    self._handle_line(line.rstrip("\r"))
            buffer += decoder.decode(b"", final=True)
            if buffer.strip():
                self._handle_line(buffer.rstrip("\r"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            self.transport_errors.append(f"reader failed: {exc}")
        finally:
            self._closed.set()
            self._settled.set()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(RpcError("pi rpc process exited"))
            self._pending.clear()

    def _handle_line(self, line: str) -> None:
        text = line.strip()
        if not text:
            return
        try:
            record = json.loads(text)
        except json.JSONDecodeError:
            # stdout is reserved for protocol records; anything else is contamination.
            # Keep it (bounded) instead of crashing the session.
            self.transport_errors.append(f"non-protocol stdout: {text[:500]}")
            self._emit({"type": "raw", "source": "pi.rpc.stdout", "raw": text[:4_000]})
            return
        if not isinstance(record, dict):
            self.transport_errors.append(f"non-object record: {text[:200]}")
            return

        record_type = record.get("type")
        if record_type == "response":
            response_id = record.get("id")
            future = self._pending.pop(response_id, None) if isinstance(response_id, str) else None
            if future is not None and not future.done():
                future.set_result(record)
            elif isinstance(response_id, str):
                # Late response for a command whose waiter already timed out.
                self.orphan_responses.append(record)
                del self.orphan_responses[:-50]
            return
        if record_type == "extension_ui_request":
            method = record.get("method")
            if method in DIALOG_METHODS:
                # Headless: never block an extension on a dialog.
                self._write_async(
                    {"type": "extension_ui_response", "id": record.get("id"), "cancelled": True}
                )
            self._emit(record)
            return
        if record_type == "agent_settled":
            # ``aborted`` is the authoritative statement from pi about *this* turn. It is
            # recorded separately: ``_abort_sent`` must never be cleared here, or a waiter
            # that wakes after this record would report the aborted turn as SETTLED.
            self._settled_aborted = bool(record.get("aborted"))
            self._settled.set()
        self._emit(record)

    def _emit(self, record: dict[str, Any]) -> None:
        sink = self._sink
        if sink is None:
            return
        try:
            sink(record)
        except Exception:  # pragma: no cover - a recorder must never kill the reader
            pass

    def set_sink(self, sink: Callable[[dict[str, Any]], None] | None) -> None:
        self._sink = sink

    # ------------------------------------------------------------------ writer
    def _write_async(self, payload: dict[str, Any]) -> None:
        """Best-effort write used from the reader task (UI replies)."""
        proc = self.proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            return
        try:
            proc.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            self.transport_errors.append("write failed (pipe closed)")
            return
        # No drain here (sync context); the event loop flushes on the next iteration.

    async def _write(self, payload: dict[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.stdin is None:
            raise RpcError("pi rpc process is not running")
        if proc.returncode is not None:
            raise RpcError(f"pi rpc process exited with code {proc.returncode}")
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
        async with self._write_lock:
            try:
                proc.stdin.write(data)
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise RpcError(f"pi rpc stdin closed: {exc}") from None

    async def command(
        self,
        command_type: str,
        *,
        timeout: float = DEFAULT_COMMAND_TIMEOUT,
        **fields: Any,
    ) -> RpcResponse:
        if not self.alive:
            raise RpcError("pi rpc process is not running")
        command_id = f"{command_type}-{uuid.uuid4().hex[:12]}"
        future: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        self._pending[command_id] = future
        payload = {"id": command_id, "type": command_type, **fields}
        try:
            await self._write(payload)
            record = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(command_id, None)
            raise RpcError(f"pi did not answer {command_type} within {timeout:g}s") from None
        finally:
            self._pending.pop(command_id, None)
        self.last_used = time.monotonic()
        return RpcResponse(
            id=command_id,
            command=str(record.get("command") or command_type),
            success=bool(record.get("success")),
            data=record.get("data") if isinstance(record.get("data"), dict) else {},
            error=str(record.get("error")) if record.get("error") else None,
        )

    # ------------------------------------------------------------------ commands
    async def prompt(self, message: str, *, timeout: float = DEFAULT_STARTUP_TIMEOUT) -> RpcResponse:
        return await self.command("prompt", message=message, timeout=timeout)

    async def steer(self, message: str, *, timeout: float | None = None) -> RpcResponse:
        return await self.command(
            "steer", message=message, timeout=timeout or steer_timeout()
        )

    async def follow_up(self, message: str, *, timeout: float | None = None) -> RpcResponse:
        return await self.command(
            "follow_up", message=message, timeout=timeout or steer_timeout()
        )

    async def abort(self, *, timeout: float = DEFAULT_COMMAND_TIMEOUT) -> RpcResponse:
        """Abort the current turn.

        ``clear_queue`` runs first: pi delivers queued steering/follow-up messages inside
        the *current* turn, so an abort without clearing would let the turn continue with a
        message the user believes was dropped. Clearing is best-effort (an older pi build
        without ``clear_queue`` must still be abortable).
        """
        self._abort_sent = True
        try:
            cleared = await self.command("clear_queue", timeout=min(timeout, 10.0))
            if cleared.ok:
                for key in ("steering", "followUp"):
                    values = cleared.data.get(key)
                    if isinstance(values, list):
                        self.last_cleared.extend(str(value) for value in values if value)
        except RpcError:
            pass
        return await self.command("abort", timeout=timeout)

    async def get_state(self, *, timeout: float = DEFAULT_COMMAND_TIMEOUT) -> dict[str, Any]:
        response = await self.command("get_state", timeout=timeout)
        return response.data if response.ok else {}

    async def last_assistant_text(self, *, timeout: float = DEFAULT_COMMAND_TIMEOUT) -> str:
        response = await self.command("get_last_assistant_text", timeout=timeout)
        if response.ok:
            value = response.data.get("text")
            if isinstance(value, str):
                return value
        return ""

    # ------------------------------------------------------------------ settling
    def clear_settled(self) -> None:
        """Start a new turn: forget the previous settle/abort state."""
        self._settled.clear()
        self._settled_aborted = False
        self._abort_sent = False

    @property
    def aborted(self) -> bool:
        """True when this turn was aborted (locally requested or pi reported it)."""
        return self._abort_sent or self._settled_aborted

    async def _is_streaming(self) -> bool:
        try:
            state = await self.get_state(timeout=5.0)
        except (RpcError, asyncio.TimeoutError):
            return False
        return bool(state.get("isStreaming") or state.get("isCompacting"))

    async def wait_settled(self, timeout: float) -> str:
        """Wait for one turn to finish.

        ``agent_settled`` is authoritative, and its ``aborted`` flag (or a locally sent
        ``abort``) makes the outcome ``ABORTED`` — never ``SETTLED``. ``abort`` is also
        the exception the pi docs do not promise an event for: when the turn is aborted
        before/while it streams, ``abort`` answers ``success`` and pi may never emit
        ``agent_settled``, so an aborted turn is additionally resolved by
        ``get_state.isStreaming == false``.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            if self._closed.is_set():
                return CRASHED
            if self._settled.is_set():
                return ABORTED if self.aborted else SETTLED
            remaining = deadline - loop.time()
            if remaining <= 0:
                return TIMED_OUT
            try:
                await asyncio.wait_for(self._settled.wait(), min(0.25, remaining))
                continue
            except asyncio.TimeoutError:
                pass
            if self.aborted and not await self._is_streaming():
                return ABORTED

    # ------------------------------------------------------------------ shutdown
    async def close(self, *, graceful: bool = True) -> None:
        if self._closing:
            return
        self._closing = True
        proc = self.proc
        if proc is None:
            return
        if graceful and proc.returncode is None and proc.stdin is not None:
            try:
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass
        try:
            await asyncio.wait_for(proc.wait(), TERM_GRACE_SECONDS if graceful else 0.5)
        except asyncio.TimeoutError:
            await _terminate_group(proc)
        except ProcessLookupError:
            pass
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
        try:
            self._stderr_file.close()
        except Exception:  # pragma: no cover - defensive
            pass
        self._closed.set()


async def _terminate_group(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        await asyncio.wait_for(proc.wait(), TERM_GRACE_SECONDS)
        return
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        return
    try:
        await asyncio.wait_for(proc.wait(), TERM_GRACE_SECONDS)
    except asyncio.TimeoutError:
        pass


def proc_cmdline(pid: int) -> list[str] | None:
    """``/proc/<pid>/cmdline`` as an argv list (None when unreadable/empty)."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    argv = [item.decode("utf-8", "replace") for item in raw.split(b"\0") if item]
    return argv or None


def proc_start_ticks(pid: int) -> int | None:
    """Process start time in clock ticks since boot (``/proc/<pid>/stat`` field 22).

    Together with the PID this is the kernel's process identity: a recycled PID has a
    different start time. Returns None when the process is gone or ``/proc`` is unreadable.
    """
    try:
        raw = Path(f"/proc/{pid}/stat").read_bytes()
    except OSError:
        return None
    # ``comm`` may contain spaces and parentheses: everything after the *last* ')' is the
    # fixed-format remainder. Field 3 (state) is index 0 there, so starttime (field 22) is
    # index 19.
    text = raw.decode("utf-8", "replace")
    closing = text.rfind(")")
    if closing < 0:
        return None
    fields = text[closing + 1 :].split()
    if len(fields) <= 19:
        return None
    try:
        return int(fields[19])
    except ValueError:
        return None


def proc_environ(pid: int) -> dict[str, str] | None:
    """``/proc/<pid>/environ`` as a mapping (None when unreadable).

    pi calls ``process.title = "pi"`` at startup, which **scrubs its argv**: a real chat
    pi's cmdline is ``pi\\0\\0\\0…`` with the ``--session-id`` flag gone. The environment
    block survives, and Cairn's per-chat variables (``CAIRN_CONTROL_CONVERSATION``,
    ``PI_CODING_AGENT_DIR``) are set at exec time, so they are the identity evidence that
    actually works for a running pi.
    """
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    environ: dict[str, str] = {}
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        key, _, value = entry.partition(b"=")
        try:
            environ[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
        except Exception:  # pragma: no cover - defensive
            continue
    return environ


def argv_has_session(argv: list[str], session_id: str) -> bool:
    """True when ``argv`` pins ``session_id`` via ``--session-id``/``--session``."""
    if not session_id:
        return False
    for index, item in enumerate(argv):
        if item in ("--session-id", "--session") and index + 1 < len(argv):
            if argv[index + 1] == session_id:
                return True
        for flag in ("--session-id=", "--session="):
            if item.startswith(flag) and item[len(flag) :] == session_id:
                return True
    return False


def pid_looks_like_pi(
    pid: int,
    *,
    session_id: str | None = None,
    conversation_id: int | None = None,
    agent_dir: str | None = None,
    start_ticks: int | None = None,
) -> bool:
    """True only when ``pid`` is *this run's* pi process.

    Identity requires:

    * the process exists and its argv basename is the configured pi binary (or ``pi``);
    * **at least one per-run token** proving it is this chat's pi:
      the ``--session-id``/``--session`` argument, or (because pi scrubs its own argv)
      ``CAIRN_CONTROL_CONVERSATION=<conversation id>`` /
      ``PI_CODING_AGENT_DIR=<per-conversation agent dir>`` in ``/proc/<pid>/environ``;
    * when a start time was recorded, ``/proc/<pid>/stat`` reports the same start time.

    A run with no per-run token is a refusal, not a wildcard: an unrelated pi (another
    chat, the user's interactive pi, a dispatcher/B44 worker) must never be signalled just
    because it happens to be called ``pi``.
    """
    argv = proc_cmdline(pid)
    if not argv:
        return False
    expected = Path(os.environ.get("CAIRN_CHAT_PI_BIN", "pi")).name
    names = {Path(item).name for item in argv}
    if expected not in names and "pi" not in names:
        return False

    evidence = False
    if session_id and argv_has_session(argv, session_id):
        evidence = True
    if not evidence:
        environ = proc_environ(pid) or {}
        if conversation_id is not None and environ.get("CAIRN_CONTROL_CONVERSATION") == str(
            conversation_id
        ):
            evidence = True
        elif agent_dir and environ.get("PI_CODING_AGENT_DIR") == str(agent_dir):
            evidence = True
    if not evidence:
        return False

    if start_ticks is not None:
        ticks = proc_start_ticks(pid)
        if ticks is None or int(ticks) != int(start_ticks):
            return False
    return True


class ChatSessionManager:
    """One warm ``pi --mode rpc`` process per conversation."""

    def __init__(self) -> None:
        self._sessions: dict[int, PiRpcSession] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._active: dict[int, int] = {}
        self._reaper: asyncio.Task[None] | None = None
        self.startup_sweep: dict[str, Any] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def _check_loop(self) -> None:
        """Drop sessions bound to a previous event loop.

        Production runs one loop for the life of the process, but tests (and any embedder
        that drives the ASGI app with several ``asyncio.run`` calls) must not inherit
        futures from a dead loop.
        """
        loop = asyncio.get_running_loop()
        if self._loop is loop:
            return
        for session in list(self._sessions.values()):
            pid = session.pid
            if pid:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        self._sessions.clear()
        self._active.clear()
        self._locks.clear()
        self._loop = loop

    # ------------------------------------------------------------------ helpers
    def _lock(self, conversation_id: int) -> asyncio.Lock:
        lock = self._locks.get(conversation_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[conversation_id] = lock
        return lock

    def session(self, conversation_id: int) -> PiRpcSession | None:
        session = self._sessions.get(conversation_id)
        if session is not None and not session.alive:
            return None
        return session

    def pid(self, conversation_id: int) -> int | None:
        session = self._sessions.get(conversation_id)
        return session.pid if session is not None else None

    def is_live(self, conversation_id: int) -> bool:
        return self.session(conversation_id) is not None

    def session_count(self) -> int:
        return len(self._sessions)

    def idle_seconds(self, conversation_id: int) -> float:
        session = self._sessions.get(conversation_id)
        if session is None:
            return 0.0
        return time.monotonic() - session.last_used

    # ------------------------------------------------------------------ lifecycle
    def start_reaper(self) -> None:
        if self._reaper is None or self._reaper.done():
            self._reaper = asyncio.create_task(self._reap_loop())

    async def _reap_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(REAP_INTERVAL_SECONDS)
                try:
                    await self.reap_idle()
                except asyncio.CancelledError:
                    raise
                except Exception:  # pragma: no cover - the reaper must keep running
                    continue
        except asyncio.CancelledError:
            return

    async def reap_idle(self) -> list[int]:
        """Close sessions past the idle cap and keep the LRU cap."""
        if os.environ.get("CAIRN_CHAT_RPC_IDLE_DISABLED", "").strip() in ("1", "true"):
            return []
        closed: list[int] = []
        now = time.monotonic()
        limit = idle_seconds()
        for conversation_id, session in list(self._sessions.items()):
            if self._active.get(conversation_id):
                continue
            if not session.alive:
                self._sessions.pop(conversation_id, None)
                closed.append(conversation_id)
                continue
            if now - session.last_used >= limit:
                await self.close_session(conversation_id)
                closed.append(conversation_id)
        # LRU cap: keep the warm set bounded.
        idle_sessions = [
            (self._sessions[cid].last_used, cid)
            for cid in list(self._sessions)
            if not self._active.get(cid)
        ]
        while len(self._sessions) > max_sessions() and idle_sessions:
            _, conversation_id = min(idle_sessions)
            idle_sessions = [item for item in idle_sessions if item[1] != conversation_id]
            await self.close_session(conversation_id)
            closed.append(conversation_id)
        return closed

    async def close_for_project(self, project_id: str) -> list[int]:
        """Close every warm session of a project (project delete)."""
        closed: list[int] = []
        for conversation_id, session in list(self._sessions.items()):
            if session.project_id == project_id:
                await self.close_session(conversation_id)
                closed.append(conversation_id)
        return closed

    async def close_session(self, conversation_id: int, *, graceful: bool = True) -> None:
        session = self._sessions.pop(conversation_id, None)
        if session is not None:
            await session.close(graceful=graceful)

    async def shutdown(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
            try:
                await self._reaper
            except (asyncio.CancelledError, Exception):
                pass
            self._reaper = None
        for conversation_id in list(self._sessions):
            await self.close_session(conversation_id)

    async def _ensure(
        self, conversation: sqlite3.Row, system_context: str
    ) -> PiRpcSession:
        self._check_loop()
        conversation_id = int(conversation["id"])
        existing = self.session(conversation_id)
        if existing is not None:
            return existing
        # Drop a dead process before spawning a replacement.
        stale = self._sessions.pop(conversation_id, None)
        if stale is not None:
            await stale.close(graceful=False)

        argv = chat_runtime.build_rpc_argv(system_context, conversation)
        try:
            # Isolated per-session config (auth/model only) and cwd. Both live under
            # runs/chat/<conversation id>, never in the worker workspace.
            chat_runtime.prepare_agent_dir(conversation_id)
        except OSError as exc:
            raise RpcError(f"failed to prepare the chat agent dir: {exc}") from None
        session = PiRpcSession(
            conversation_id=conversation_id,
            project_id=conversation["project_id"],
            argv=argv,
            cwd=chat_runtime.working_directory(conversation_id, conversation["project_id"]),
            env=chat_runtime.build_child_env(conversation),
            stderr_path=chat_runtime.log_dir(conversation_id) / f"rpc-{uuid.uuid4().hex[:8]}.stderr.log",
        )
        await session.start()
        self._sessions[conversation_id] = session
        return session

    # ------------------------------------------------------------------ turn
    async def run_turn(
        self,
        *,
        conversation: sqlite3.Row,
        system_context: str,
        user_message: str,
        recorder: Any,
        run: Any,
        timeout: float,
    ) -> RpcTurnOutcome:
        conversation_id = int(conversation["id"])
        # Bind the manager to this event loop *before* counting the turn: _check_loop()
        # drops state from a previous loop (tests create one loop per scenario).
        self._check_loop()
        async with self._lock(conversation_id):
            self._active[conversation_id] = self._active.get(conversation_id, 0) + 1
            try:
                try:
                    session = await self._ensure(conversation, system_context)
                except FileNotFoundError as exc:
                    return RpcTurnOutcome(
                        settle=CRASHED, text="", error=f"pi executable not found: {exc}"
                    )
                except OSError as exc:
                    return RpcTurnOutcome(settle=CRASHED, text="", error=f"failed to start pi: {exc}")
                except RpcError as exc:
                    return RpcTurnOutcome(settle=CRASHED, text="", error=str(exc))

                if run.pid_writer is not None:
                    run.pid_writer(session.pid)
                run.proc = session.proc  # stop_run uses this for the legacy kill path

                session.set_sink(recorder.feed_event)
                await self._drop_stale_queue(session, recorder)
                session.clear_settled()
                session.last_cleared = []
                started = time.monotonic()
                # The session header is not emitted in RPC mode; ask pi instead so the
                # trace still records which pi session served the turn.
                try:
                    state = await session.get_state(timeout=15.0)
                    if state.get("sessionId"):
                        recorder.note_session(str(state["sessionId"]))
                except RpcError:
                    state = {}

                if getattr(run, "stop_requested", False):
                    # Stop arrived while the session was starting: do not start a model
                    # run at all. Reported as ABORTED (a stop, not a failure).
                    self._record_cleared(session, recorder)
                    session.last_cleared = []
                    return RpcTurnOutcome(
                        settle=ABORTED,
                        text=recorder.last_assistant_text(),
                        error=None,
                        exit_code=session.proc.returncode if session.proc else None,
                        stderr_tail=session.stderr_tail(),
                    )

                try:
                    response = await session.prompt(
                        user_message,
                        timeout=min(timeout, DEFAULT_STARTUP_TIMEOUT),
                    )
                except (RpcError, asyncio.TimeoutError) as exc:
                    return RpcTurnOutcome(
                        settle=CRASHED,
                        text="",
                        error=f"pi rpc prompt failed: {exc}",
                        exit_code=session.proc.returncode if session.proc else None,
                        stderr_tail=session.stderr_tail(),
                    )
                if not response.ok:
                    return RpcTurnOutcome(
                        settle=CRASHED,
                        text="",
                        error=f"pi rejected the prompt: {response.error or 'unknown error'}",
                        exit_code=session.proc.returncode if session.proc else None,
                        stderr_tail=session.stderr_tail(),
                    )
                if getattr(run, "stop_requested", False):
                    # Stop raced with prompt acceptance. Abort now: otherwise the run the
                    # prompt just started would be a no-op stop and complete normally.
                    try:
                        await session.abort()
                    except RpcError:
                        pass
                if response.disposition == "handled":
                    # pi consumed the prompt without starting a run (extension command or
                    # input handler). Waiting for agent_settled would hang until timeout.
                    # The text must be this run's: a session-wide read would resurrect the
                    # previous turn's reply.
                    return RpcTurnOutcome(
                        settle=SETTLED,
                        text=recorder.last_assistant_text(),
                        error=None,
                        exit_code=session.proc.returncode if session.proc else None,
                        stderr_tail=session.stderr_tail(),
                        disposition=response.disposition,
                    )

                remaining = max(1.0, timeout - (time.monotonic() - started))
                outcome = await session.wait_settled(remaining)
                if outcome == TIMED_OUT:
                    try:
                        await session.abort()
                    except RpcError:
                        pass
                    await session.close(graceful=False)
                    self._sessions.pop(conversation_id, None)
                if session.last_cleared:
                    # An abort's clear_queue discarded these messages: record them as
                    # dropped so a "queued" steering row never implies delivery.
                    self._record_cleared(session, recorder)
                session.last_cleared = []
                # Per-run text only. ``get_last_assistant_text`` is session-scoped, so it
                # would hand a turn that produced no assistant message the previous turn's
                # reply.
                return RpcTurnOutcome(
                    settle=outcome,
                    text=recorder.last_assistant_text(),
                    error=None,
                    exit_code=session.proc.returncode if session.proc else None,
                    stderr_tail=session.stderr_tail(),
                    disposition=response.disposition,
                )
            finally:
                self._active[conversation_id] = max(
                    0, self._active.get(conversation_id, 1) - 1
                )
                session = self._sessions.get(conversation_id)
                if session is not None:
                    session.set_sink(None)
                    session.last_used = time.monotonic()
                    if not session.alive:
                        self._sessions.pop(conversation_id, None)

    @staticmethod
    def _record_cleared(session: PiRpcSession, recorder: Any) -> None:
        """Record messages an abort's ``clear_queue`` discarded (never silently lost)."""
        for text in session.last_cleared:
            try:
                recorder.note_steering(
                    text,
                    status="dropped",
                    error="pi queue was cleared by the stop; not delivered",
                )
            except Exception:  # pragma: no cover - bookkeeping only
                pass

    @staticmethod
    async def _drop_stale_queue(session: PiRpcSession, recorder: Any) -> None:
        """Drop messages pi still had queued when the previous turn ended.

        A ``steer`` that races with turn completion can be queued by pi after the run
        settled; delivering it with the *next* prompt would be a stale instruction the user
        believes was dropped. The queue is cleared at turn start and every dropped message
        is recorded honestly (``status=dropped``) instead of leaking into the prompt.
        """
        try:
            cleared = await session.command("clear_queue", timeout=10.0)
        except RpcError:
            return
        if not cleared.ok:
            return
        dropped = []
        for key in ("steering", "followUp"):
            values = cleared.data.get(key)
            if isinstance(values, list):
                dropped.extend(str(value) for value in values if value)
        for text in dropped:
            try:
                recorder.note_steering(
                    text,
                    status="dropped",
                    error="queued after the previous turn ended; not delivered",
                )
            except Exception:  # pragma: no cover - never fail a turn on bookkeeping
                pass

    # ------------------------------------------------------------------ steering
    async def steer(self, conversation_id: int, message: str) -> dict[str, Any]:
        """Send a live steering message. Only accepted while a turn is running.

        pi happily queues a ``steer`` on an idle session, but that message would then be
        delivered with whatever prompt comes next — a stale instruction the user believes
        was dropped. Cairn therefore refuses to steer an idle conversation.
        """
        self._check_loop()
        if not self._active.get(conversation_id):
            return {
                "accepted": False,
                "reason": "no_active_turn",
                "detail": "Conversation has no running turn to steer",
            }
        session = self.session(conversation_id)
        if session is None:
            return {
                "accepted": False,
                "reason": "no_live_session",
                "detail": "No live pi rpc session for this conversation",
            }
        try:
            response = await session.steer(message)
        except RpcError as exc:
            return {"accepted": False, "reason": "rpc_error", "detail": str(exc)}
        if not response.ok:
            return {
                "accepted": False,
                "reason": "rejected",
                "detail": response.error or "pi rejected the steer",
            }
        return {
            "accepted": True,
            "disposition": response.disposition,
            "detail": "queued for delivery before the next model call",
        }

    async def follow_up(self, conversation_id: int, message: str) -> dict[str, Any]:
        session = self.session(conversation_id)
        if session is None:
            return {"accepted": False, "reason": "no_live_session"}
        try:
            response = await session.follow_up(message)
        except RpcError as exc:
            return {"accepted": False, "reason": "rpc_error", "detail": str(exc)}
        if not response.ok:
            return {"accepted": False, "reason": "rejected", "detail": response.error}
        return {"accepted": True, "disposition": response.disposition}

    async def abort(self, conversation_id: int) -> bool:
        """Ask pi to abort the current turn (the session stays warm)."""
        self._check_loop()
        session = self.session(conversation_id)
        if session is None:
            return False
        try:
            response = await session.abort()
        except RpcError:
            return False
        return response.ok


_manager: ChatSessionManager | None = None


def manager() -> ChatSessionManager:
    global _manager
    if _manager is None:
        _manager = ChatSessionManager()
    return _manager


def reset_manager() -> None:
    """Test hook: drop the singleton so a fresh event loop gets fresh state."""
    global _manager
    _manager = None
