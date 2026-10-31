from __future__ import annotations

import codecs
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
import logging
import threading
import time
from typing import Any, Protocol, runtime_checkable

from docker.errors import APIError, DockerException
from docker.models.containers import Container

LOG = logging.getLogger(__name__)
EXEC_KILL_JOIN_TIMEOUT_SECONDS = 5.0


@dataclass(slots=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False
    cancelled: bool = False
    cancel_reason: str | None = None


@runtime_checkable
class ExecProcess(Protocol):
    """A worker process, regardless of whether it runs inside a container or on the host.

    Container mode uses ManagedProcess; local mode uses LocalProcess. Both expose this
    surface so the task runners, heartbeat lease and cancellation stay backend-agnostic.
    """

    def start(self) -> None: ...

    def communicate(self, timeout: float | None) -> ProcessResult: ...

    def kill(self) -> None: ...

    def cancel(self, reason: str) -> None: ...


class ManagedProcess:
    def __init__(
        self,
        container: Container,
        command: list[str],
        env: dict[str, str],
        on_stdout_line: Callable[[str], None] | None = None,
    ):
        self.command = command
        self.env = env
        self._container = container
        self._api = container.client.api
        self._exec_id: str | None = None
        self._reader: threading.Thread | None = None
        self._stdout: list[str] = []
        self._stderr: list[str] = []
        self._returncode: int | None = None
        self._timed_out = False
        self._cancel_reason: str | None = None
        self._read_error: str | None = None
        self._done = threading.Event()
        self._timeout_lock = threading.Lock()
        self._on_stdout_line = on_stdout_line
        self._stdout_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._stderr_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._stdout_pending = ""

    def start(self) -> None:
        exec_info = self._api.exec_create(
            self._container.id,
            self.command,
            stdout=True,
            stderr=True,
            stdin=False,
            tty=False,
            environment=self.env,
        )
        self._exec_id = exec_info["Id"]
        self._reader = threading.Thread(target=self._read_stream, daemon=True)
        self._reader.start()

    def communicate(self, timeout: float | None) -> ProcessResult:
        assert self._reader is not None
        self._reader.join(timeout=timeout)
        if self._reader.is_alive():
            self._timed_out = True
            self.kill()
            self._reader.join(timeout=EXEC_KILL_JOIN_TIMEOUT_SECONDS)
        if self._reader.is_alive():
            if self._returncode is None:
                self._returncode = 137
            self._done.set()
        self._done.wait(timeout=0)
        if self._read_error and not self._stderr:
            self._stderr.append(self._read_error)
        return ProcessResult(
            returncode=self._returncode if self._returncode is not None else 1,
            stdout="".join(self._stdout),
            stderr="".join(self._stderr),
            timed_out=self._timed_out,
            cancelled=self._cancel_reason is not None,
            cancel_reason=self._cancel_reason,
        )

    def mark_timed_out(self) -> None:
        with self._timeout_lock:
            self._timed_out = True

    def kill(self) -> None:
        if self._exec_id is None:
            return
        try:
            details = self._api.exec_inspect(self._exec_id)
        except DockerException as exc:
            LOG.warning("failed to inspect exec before kill exec_id=%s error=%s", self._exec_id, exc)
            return
        if not details.get("Running"):
            return
        pid = details.get("Pid")
        if not pid:
            LOG.warning("container exec missing pid for kill exec_id=%s", self._exec_id)
            return
        self._kill_pid(int(pid))

    def cancel(self, reason: str) -> None:
        if self._cancel_reason is None:
            self._cancel_reason = reason
        self.kill()

    def _read_stream(self) -> None:
        assert self._exec_id is not None
        stream: Any | None = None
        try:
            stream = self._api.exec_start(
                self._exec_id,
                detach=False,
                tty=False,
                stream=True,
                demux=True,
            )
            for chunk in stream:
                stdout, stderr = self._split_chunk(chunk)
                if stdout is not None:
                    self._consume_stdout(stdout)
                if stderr is not None:
                    self._consume_stderr(stderr)
        except DockerException as exc:
            self._read_error = str(exc)
        finally:
            self._flush_stream_decoders()
            self._close_stream(stream)
            self._returncode = self._resolve_exit_code()
            self._done.set()

    def _consume_stdout(self, chunk: bytes | str) -> None:
        text = self._decode_incremental(self._stdout_decoder, chunk)
        if not text:
            return
        # Final stdout capture is the concatenation of the decoded stream, exactly as
        # before, but decoded incrementally so split UTF-8 never becomes U+FFFD.
        self._stdout.append(text)
        if self._on_stdout_line is None:
            return
        self._stdout_pending += text
        parts = self._stdout_pending.split("\n")
        self._stdout_pending = parts[-1]
        for line in parts[:-1]:
            self._emit_stdout_line(line)

    def _consume_stderr(self, chunk: bytes | str) -> None:
        text = self._decode_incremental(self._stderr_decoder, chunk)
        if text:
            self._stderr.append(text)

    def _flush_stream_decoders(self) -> None:
        tail = self._stdout_decoder.decode(b"", final=True)
        if tail:
            self._stdout.append(tail)
            self._stdout_pending += tail
        if self._on_stdout_line is not None and self._stdout_pending:
            # A final line without a trailing LF is still a complete record.
            self._emit_stdout_line(self._stdout_pending)
        self._stdout_pending = ""
        stderr_tail = self._stderr_decoder.decode(b"", final=True)
        if stderr_tail:
            self._stderr.append(stderr_tail)

    def _emit_stdout_line(self, line: str) -> None:
        assert self._on_stdout_line is not None
        try:
            self._on_stdout_line(line[:-1] if line.endswith("\r") else line)
        except Exception:  # pragma: no cover - a callback must never kill the reader
            LOG.warning("stdout line callback failed", exc_info=True)

    @staticmethod
    def _close_stream(stream: Any | None) -> None:
        if stream is None:
            return
        close = getattr(stream, "close", None)
        if callable(close):
            with suppress(Exception):
                close()
        response = getattr(stream, "_response", None)
        response_close = getattr(response, "close", None)
        if callable(response_close):
            with suppress(Exception):
                response_close()

    def _resolve_exit_code(self) -> int:
        assert self._exec_id is not None
        deadline = time.monotonic() + EXEC_KILL_JOIN_TIMEOUT_SECONDS
        while True:
            try:
                details = self._api.exec_inspect(self._exec_id)
            except DockerException as exc:
                if self._read_error is None:
                    self._read_error = str(exc)
                return 137 if self._timed_out else 1
            exit_code = details.get("ExitCode")
            if exit_code is not None:
                return int(exit_code)
            if time.monotonic() >= deadline:
                return 137 if self._timed_out else 1
            time.sleep(0.1)

    def _kill_pid(self, pid: int) -> None:
        last_error: str | None = None
        for command in (
            # Kill the process group first (docker exec starts the command as a group
            # leader), then the pid as a fallback for older shells.
            ["kill", "-KILL", f"-{pid}"],
            ["kill", "-KILL", str(pid)],
            ["/bin/sh", "-lc", f"kill -KILL -- -{pid} 2>/dev/null || kill -KILL {pid}"],
            ["sh", "-lc", f"kill -KILL -- -{pid} 2>/dev/null || kill -KILL {pid}"],
        ):
            try:
                result = self._container.exec_run(command, stdout=False, stderr=False)
            except APIError as exc:
                last_error = str(exc)
                continue
            exit_code = result.exit_code if hasattr(result, "exit_code") else None
            if exit_code in (None, 0, 1):
                return
        if last_error is not None:
            LOG.warning("failed to kill container exec pid=%s container=%s error=%s", pid, self._container.name, last_error)

    @staticmethod
    def _split_chunk(chunk: Any) -> tuple[bytes | str | None, bytes | str | None]:
        if isinstance(chunk, tuple):
            return chunk
        return chunk, None

    @staticmethod
    def _decode_incremental(decoder, chunk: bytes | str) -> str:
        if isinstance(chunk, str):
            return chunk
        return decoder.decode(chunk, final=False)
