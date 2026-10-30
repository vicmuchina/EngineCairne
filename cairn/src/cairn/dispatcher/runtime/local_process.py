from __future__ import annotations

import codecs
import logging
import os
import signal
import subprocess
import threading
from collections.abc import Callable
from contextlib import suppress

from cairn.dispatcher.runtime.process import ProcessResult

LOG = logging.getLogger(__name__)

READ_CHUNK_SIZE = 65536
STREAM_JOIN_TIMEOUT_SECONDS = 5.0
FORCE_KILL_REAP_TIMEOUT_SECONDS = 2.0

LineCallback = Callable[[str], None]


class LocalProcess:
    """Runs a worker command as a host subprocess.

    Mirrors the container ManagedProcess surface (start/communicate/kill/cancel) but
    executes on the dispatcher host: its own process group so children are killed as a
    group, a Python-enforced timeout instead of the ``timeout`` coreutil, and a
    SIGTERM -> grace -> SIGKILL shutdown so the CLI can flush its session before dying.

    ``on_stdout_line`` receives every complete stdout line (LF framed, without the LF)
    while the process is still running. Decoding is incremental, so a multibyte UTF-8
    character split across pipe reads is reassembled rather than replaced. The final
    ``ProcessResult.stdout`` is unchanged: it is the same full stream, decoded once.
    Callback failures are logged and never break the reader thread.
    """

    def __init__(
        self,
        command: list[str],
        cwd: str,
        env: dict[str, str],
        timeout_seconds: int | None = None,
        term_grace_seconds: int = 5,
        on_stdout_line: LineCallback | None = None,
    ):
        self.command = command
        self.env = env
        self._cwd = cwd
        self._timeout_seconds = timeout_seconds
        self._term_grace = max(1.0, float(term_grace_seconds))
        self._on_stdout_line = on_stdout_line
        self._process: subprocess.Popen[bytes] | None = None
        self._stdout_chunks: list[str] = []
        self._stderr_chunks: list[str] = []
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._timed_out = False
        self._cancel_reason: str | None = None
        self._kill_lock = threading.Lock()

    def start(self) -> None:
        # Binary pipes + one incremental decoder per stream: the decoder is what makes a
        # UTF-8 sequence split across two reads safe. Text mode would decode each read
        # independently and corrupt the character.
        self._process = subprocess.Popen(
            self.command,
            cwd=self._cwd,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self._stdout_thread = threading.Thread(
            target=self._drain,
            args=(
                self._process.stdout,
                self._stdout_chunks,
                codecs.getincrementaldecoder("utf-8")(errors="replace"),
                self._on_stdout_line,
            ),
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._drain,
            args=(
                self._process.stderr,
                self._stderr_chunks,
                codecs.getincrementaldecoder("utf-8")(errors="replace"),
                None,
            ),
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    def communicate(self, timeout: float | None) -> ProcessResult:
        assert self._process is not None
        wait_for = float(self._timeout_seconds) if self._timeout_seconds is not None else timeout
        try:
            self._process.wait(timeout=wait_for)
        except subprocess.TimeoutExpired:
            self._timed_out = True
            self._terminate()
        with suppress(subprocess.TimeoutExpired):
            self._process.wait(timeout=FORCE_KILL_REAP_TIMEOUT_SECONDS)
        if self._stdout_thread is not None:
            self._stdout_thread.join(timeout=STREAM_JOIN_TIMEOUT_SECONDS)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=STREAM_JOIN_TIMEOUT_SECONDS)
        returncode = self._process.returncode
        if returncode is None:
            returncode = 137 if self._timed_out else 1
        return ProcessResult(
            returncode=returncode,
            stdout=self._universal_newlines("".join(self._stdout_chunks)),
            stderr=self._universal_newlines("".join(self._stderr_chunks)),
            timed_out=self._timed_out,
            cancelled=self._cancel_reason is not None,
            cancel_reason=self._cancel_reason,
        )

    def kill(self) -> None:
        self._terminate()

    def cancel(self, reason: str) -> None:
        if self._cancel_reason is None:
            self._cancel_reason = reason
        self._terminate()

    def _terminate(self) -> None:
        with self._kill_lock:
            process = self._process
            if process is None or process.poll() is not None:
                return
            self._signal_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=self._term_grace)
                return
            except subprocess.TimeoutExpired:
                pass
            self._signal_group(process, signal.SIGKILL)

    @staticmethod
    def _universal_newlines(text: str) -> str:
        """Match the old ``text=True`` capture: universal newline translation.

        Callbacks already receive LF-framed lines with ``\r`` stripped; this only keeps the
        final ``ProcessResult.stdout/stderr`` byte-compatible with the pre-callback code.
        """
        return text.replace("\r\n", "\n").replace("\r", "\n")

    @staticmethod
    def _signal_group(process: subprocess.Popen[bytes], sig: int) -> None:
        try:
            os.killpg(os.getpgid(process.pid), sig)
        except (ProcessLookupError, PermissionError):
            with suppress(ProcessLookupError, PermissionError, ValueError):
                process.send_signal(sig)

    @staticmethod
    def _drain(
        pipe,
        sink: list[str],
        decoder,
        on_line: LineCallback | None,
    ) -> None:
        pending = ""

        def emit(line: str) -> None:
            if on_line is None:
                return
            try:
                on_line(line[:-1] if line.endswith("\r") else line)
            except Exception:  # pragma: no cover - a callback must never kill the reader
                LOG.warning("stdout line callback failed", exc_info=True)

        try:
            while True:
                # read1 returns as soon as bytes are available; read(n) may wait for the
                # full buffer, which would delay live events until the process exits.
                read = getattr(pipe, "read1", None)
                chunk = read(READ_CHUNK_SIZE) if callable(read) else pipe.read(READ_CHUNK_SIZE)
                if not chunk:
                    break
                text = decoder.decode(chunk, final=False)
                if not text:
                    continue
                sink.append(text)
                if on_line is None:
                    continue
                pending += text
                if "\n" not in pending:
                    continue
                *complete, pending = pending.split("\n")
                for line in complete:
                    emit(line)
            tail = decoder.decode(b"", final=True)
            if tail:
                sink.append(tail)
                pending += tail
            if on_line is not None and pending:
                # A final line without a trailing LF is still a complete record.
                emit(pending)
        except (ValueError, OSError):
            pass
        finally:
            with suppress(Exception):
                pipe.close()
