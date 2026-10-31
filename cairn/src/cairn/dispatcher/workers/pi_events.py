from __future__ import annotations

"""Map ``pi --mode json`` stdout events to worker activity emissions.

The dispatcher runs pi with ``--mode json``; every stdout line is one JSON event. This
module owns the interpretation of those events (never the transport): it turns the exact
events pi emitted into :class:`WorkerEmission` records that
:class:`cairn.dispatcher.workers.activity.WorkerActivityRecorder` persists as
``project_activity`` rows.

Rules:

* only events pi actually emitted produce an emission; nothing is synthesized;
* assistant text/thinking are accumulated and flushed at their ``*_end`` event (with a
  time-throttled partial for the live view);
* tool calls are keyed by ``toolCallId`` so a result is paired with the call that produced
  it, not with the adjacent event;
* ``system``/``user``/``toolResult`` messages are not conversation transcript here (the tool
  result is already captured by ``tool_execution_end``);
* non-JSON stdout is preserved verbatim as ``worker_output`` (bounded), never guessed at.
"""

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

MAX_DESCRIPTION = 20_000
MAX_RAW = 4_000
# Keep the serialized metadata object comfortably below the server's 20 k metadata clip:
# a mid-JSON truncation would make the whole object unparseable.
MAX_METADATA_TEXT = 8_000
STREAM_UPDATE_SECONDS = 0.5

# pi puts the event type first. Sniffing it lets us skip huge lifecycle payloads
# (``agent_end`` carries the whole conversation) without json.loads-ing megabytes of JSON
# that produce no worker activity row.
_TYPE_PREFIX = re.compile(r'\s*\{\s*"type"\s*:\s*"([A-Za-z0-9_]+)"')
_HANDLED_TYPES = frozenset(
    {
        "session",
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "extension_error",
        "error",
        "auto_retry_end",
    }
)



@dataclass(slots=True)
class WorkerEmission:
    """One worker activity row to persist (or update, when ``update`` is true)."""

    slot: str
    kind: str
    status: str
    title: str
    description: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    update: bool = False


@dataclass(slots=True)
class _Accum:
    text: str = ""
    last_emit: float = 0.0
    emitted: bool = False


@dataclass(slots=True)
class _Tool:
    call_id: str
    name: str
    input_text: str
    result_text: str = ""
    last_emit: float = 0.0


def _clip(value: str | None, limit: int = MAX_DESCRIPTION) -> str | None:
    if value is None:
        return None
    if len(value) <= limit:
        return value
    return value[:limit] + f"…[truncated {len(value) - limit} chars]"


def bounded_raw(value: Any, limit: int = MAX_RAW) -> str:
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = repr(value)
    return _clip(text, limit) or ""


def _json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return repr(value)


def _message_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def _result_text(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if not isinstance(result, dict):
        return _json_text(result)
    content = result.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif item.get("type") == "image":
                parts.append("[image]")
    if not parts and result.get("details") is not None:
        parts.append(_json_text(result.get("details")))
    return "\n".join(part for part in parts if part)


def _usage(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    return {
        key: usage.get(key)
        for key in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "cost")
        if key in usage
    }


class PiWorkerEventParser:
    """Stateful parser for one worker ``pi --mode json`` process."""

    def __init__(self, worker: str):
        self.worker = worker
        self.session: str | None = None
        self._message_meta: dict[str, Any] = {}
        self._message_open = False
        self._text_blocks: dict[int, _Accum] = {}
        self._thinking: dict[int, _Accum] = {}
        self._tools: dict[str, _Tool] = {}
        self._error_index = 0
        self._output_index = 0

    # -- public -----------------------------------------------------------
    def feed_line(self, line: str) -> list[WorkerEmission]:
        text = line.strip()
        if not text:
            return []
        match = _TYPE_PREFIX.match(text)
        if (
            match is not None
            and match.group(1) not in _HANDLED_TYPES
            and len(text) > 4096
        ):
            # Huge lifecycle/unknown event: no transcript content. Skipping before
            # json.loads matters because agent_end can carry the entire conversation.
            return []
        try:
            event = json.loads(text)
        except json.JSONDecodeError:
            return [self._raw_output(line)]
        if not isinstance(event, dict):
            return [self._raw_output(line)]
        return self.feed_event(event)

    def feed_event(self, event: dict[str, Any]) -> list[WorkerEmission]:
        if not isinstance(event, dict):
            return []
        kind = event.get("type")
        if not isinstance(kind, str) or not kind:
            return []
        if kind == "session":
            session_id = event.get("id")
            if isinstance(session_id, str) and session_id:
                self.session = session_id
            return []
        if kind == "message_start":
            return self._message_start(event.get("message"))
        if kind == "message_update":
            return self._message_update(event)
        if kind == "message_end":
            return self._message_end(event.get("message"))
        if kind == "tool_execution_start":
            return self._tool_start(event)
        if kind == "tool_execution_update":
            return self._tool_update(event)
        if kind == "tool_execution_end":
            return self._tool_end(event)
        if kind in ("extension_error", "error"):
            return [self._error(event)]
        if kind == "auto_retry_end":
            final_error = event.get("finalError")
            if final_error:
                return [self._error({**event, "error": final_error}, source="auto_retry_end")]
            return []
        # agent_start/turn_start/turn_end/agent_end/compaction/retry/... are lifecycle
        # markers with no transcript content of their own. The worker_run start/finish
        # rows cover the lifecycle; nothing is invented here.
        return []

    def flush(self) -> list[WorkerEmission]:
        """Flush accumulated-but-not-yet-emitted text before the run is closed."""
        out: list[WorkerEmission] = []
        for index, accum in sorted(self._thinking.items()):
            if accum.text:
                out.append(self._thinking_emission(index, accum.text, "streaming", update=True))
        self._thinking.clear()
        if self._message_open:
            text = self._joined_text()
            if text:
                out.append(self._message_emission(text, "streaming", update=True))
        for tool in self._tools.values():
            if tool.result_text:
                out.append(self._tool_result_emission(tool, tool.result_text, "running", update=True))
        return out

    # -- messages ---------------------------------------------------------
    def _message_start(self, message: Any) -> list[WorkerEmission]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return []
        self._message_meta = {
            "model": message.get("model"),
            "provider": message.get("provider"),
            "pi_timestamp": message.get("timestamp"),
        }
        self._message_open = False
        self._text_blocks = {}
        # A new assistant message is a new block sequence; any thinking block left open
        # by a malformed stream belongs to the previous message.
        self._thinking = {}
        return []

    def _ensure_message(self) -> list[WorkerEmission]:
        if self._message_open:
            return []
        self._message_open = True
        return [
            WorkerEmission(
                slot="message",
                kind="worker_message",
                status="streaming",
                title=f"worker {self.worker} message",
                description="",
                metadata=dict(self._message_meta),
                update=False,
            )
        ]

    def _joined_text(self) -> str:
        return "".join(self._text_blocks[index].text for index in sorted(self._text_blocks))

    def _message_emission(self, text: str, status: str, *, update: bool, **extra: Any) -> WorkerEmission:
        metadata = {**self._message_meta, **extra}
        return WorkerEmission(
            slot="message",
            kind="worker_message",
            status=status,
            title=f"worker {self.worker} message",
            description=_clip(text),
            metadata=metadata,
            update=update,
        )

    def _message_update(self, event: dict[str, Any]) -> list[WorkerEmission]:
        ame = event.get("assistantMessageEvent")
        if not isinstance(ame, dict):
            return []
        atype = ame.get("type")
        index = int(ame.get("contentIndex") or 0)
        now = time.monotonic()
        if atype in ("text_start", "text_delta", "text_end"):
            out = self._ensure_message()
            accum = self._text_blocks.setdefault(index, _Accum())
            if atype == "text_delta" and isinstance(ame.get("delta"), str):
                accum.text += ame["delta"]
                if now - accum.last_emit >= STREAM_UPDATE_SECONDS:
                    accum.last_emit = now
                    out.append(self._message_emission(self._joined_text(), "streaming", update=True))
            elif atype == "text_end" and isinstance(ame.get("content"), str):
                accum.text = ame["content"]
                accum.last_emit = now
                out.append(self._message_emission(self._joined_text(), "streaming", update=True))
            return out
        if atype in ("thinking_start", "thinking_delta", "thinking_end"):
            accum = self._thinking.setdefault(index, _Accum())
            if atype == "thinking_start":
                if not accum.text:
                    accum.last_emit = now
                    accum.emitted = False
                    return [self._thinking_emission(index, "", "streaming", update=False)]
                return []
            if atype == "thinking_delta" and isinstance(ame.get("delta"), str):
                accum.text += ame["delta"]
                # The first delta updates immediately so the live view is not an empty
                # "thinking" card for the first half second; later deltas are throttled.
                if not accum.emitted or now - accum.last_emit >= STREAM_UPDATE_SECONDS:
                    accum.last_emit = now
                    accum.emitted = True
                    return [self._thinking_emission(index, accum.text, "streaming", update=True)]
                return []
            if atype == "thinking_end":
                if isinstance(ame.get("content"), str):
                    accum.text = ame["content"]
                self._thinking.pop(index, None)
                return [self._thinking_emission(index, accum.text, "done", update=True)]
            return []
        if atype == "error":
            error = ame.get("error")
            message = error.get("errorMessage") if isinstance(error, dict) else None
            return [
                self._error(
                    {**event, "error": message or ame.get("reason") or "pi message error"},
                    source="message_update",
                )
            ]
        # toolcall_start/delta/end are followed by tool_execution_* with the authoritative
        # call id/arguments; persisting the deltas would duplicate the call.
        return []

    def _thinking_emission(self, index: int, text: str, status: str, *, update: bool) -> WorkerEmission:
        return WorkerEmission(
            slot=f"thinking:{index}",
            kind="worker_thinking",
            status=status,
            title=f"worker {self.worker} thinking",
            description=_clip(text),
            metadata={"content_index": index},
            update=update,
        )

    def _message_end(self, message: Any) -> list[WorkerEmission]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return []
        out: list[WorkerEmission] = []
        text = _message_text(message)
        if not text:
            text = self._joined_text()
        stop_reason = message.get("stopReason")
        status = "done"
        error: str | None = None
        if stop_reason == "error":
            status = "error"
            error = message.get("errorMessage") or "pi stopReason=error"
        elif stop_reason == "aborted":
            status = "stopped"
        if text or self._message_open:
            out.append(
                self._message_emission(
                    text,
                    status,
                    update=self._message_open,
                    stop_reason=stop_reason,
                    usage=_usage(message),
                    raw=bounded_raw(
                        {
                            "role": message.get("role"),
                            "model": message.get("model"),
                            "provider": message.get("provider"),
                            "stopReason": stop_reason,
                            "content": _clip(text, MAX_METADATA_TEXT),
                        }
                    ),
                )
            )
        # Usage is reported on every assistant message, including tool-call-only turns
        # that produce no text row. Track those turns explicitly so the run total is not
        # silently limited to the single message that happened to contain prose.
        if not (text or self._message_open):
            usage = _usage(message)
            if usage is not None:
                out.append(
                    WorkerEmission(
                        slot="usage",
                        kind="worker_usage",
                        status="done",
                        title=f"worker {self.worker} usage",
                        metadata={"usage": usage, "model": message.get("model")},
                    )
                )
        # Close a thinking block pi did not terminate explicitly; keep the text it emitted.
        for index, accum in sorted(self._thinking.items()):
            if accum.text:
                out.append(self._thinking_emission(index, accum.text, "done", update=True))
        self._thinking.clear()
        self._message_open = False
        self._text_blocks = {}
        if status == "error":
            out.append(self._error({**message, "error": error}, source="message_end"))
        return out

    # -- tools ------------------------------------------------------------
    def _tool_start(self, event: dict[str, Any]) -> list[WorkerEmission]:
        call_id = str(event.get("toolCallId") or "")
        if not call_id:
            return []
        tool = _Tool(
            call_id=call_id,
            name=str(event.get("toolName") or "unknown"),
            input_text=_json_text(event.get("args")),
        )
        self._tools[call_id] = tool
        return [
            WorkerEmission(
                slot=f"tool:{call_id}",
                kind="tool_call",
                status="running",
                title=f"Tool {tool.name}",
                description=_clip(tool.input_text),
                metadata={
                    "tool_name": tool.name,
                    "tool_call_id": call_id,
                    "tool_input": _clip(tool.input_text, MAX_METADATA_TEXT),
                    "raw": bounded_raw(
                        {
                            "type": "tool_execution_start",
                            "toolCallId": call_id,
                            "toolName": tool.name,
                            "args": _clip(tool.input_text, MAX_METADATA_TEXT),
                        }
                    ),
                },
                update=False,
            ),
            WorkerEmission(
                slot=f"toolresult:{call_id}",
                kind="tool_result",
                status="running",
                title=f"Tool {tool.name} result",
                description="",
                metadata={"tool_name": tool.name, "tool_call_id": call_id},
                update=False,
            ),
        ]

    def _tool_update(self, event: dict[str, Any]) -> list[WorkerEmission]:
        call_id = str(event.get("toolCallId") or "")
        tool = self._tools.get(call_id)
        if tool is None:
            return []
        text = _result_text(event.get("partialResult"))
        if not text:
            return []
        tool.result_text = text
        now = time.monotonic()
        if now - tool.last_emit < STREAM_UPDATE_SECONDS:
            return []
        tool.last_emit = now
        return [self._tool_result_emission(tool, text, "running", update=True)]

    def _tool_end(self, event: dict[str, Any]) -> list[WorkerEmission]:
        call_id = str(event.get("toolCallId") or "")
        tool = self._tools.get(call_id)
        name = str(event.get("toolName") or (tool.name if tool else "unknown"))
        is_error = bool(event.get("isError"))
        text = _result_text(event.get("result"))
        status = "error" if is_error else "done"
        out: list[WorkerEmission] = []
        if tool is None:
            # tool_execution_end without a start: persist the real call and its result,
            # keyed by the id pi gave us.
            tool = _Tool(call_id=call_id or f"unknown-{time.monotonic_ns()}", name=name,
                         input_text=_json_text(event.get("args")))
            out.append(
                WorkerEmission(
                    slot=f"tool:{tool.call_id}",
                    kind="tool_call",
                    status=status,
                    title=f"Tool {name}",
                    description=_clip(tool.input_text),
                    metadata={"tool_name": name, "tool_call_id": call_id,
                              "tool_input": _clip(tool.input_text, MAX_METADATA_TEXT)},
                    update=False,
                )
            )
            result_update = False
        else:
            result_update = True
            out.append(
                WorkerEmission(
                    slot=f"tool:{call_id}",
                    kind="tool_call",
                    status=status,
                    title=f"Tool {name}",
                    description=None,
                    metadata={},
                    update=True,
                )
            )
        tool.result_text = text
        out.append(
            self._tool_result_emission(
                tool,
                text,
                status,
                update=result_update,
                is_error=is_error,
                duration_ms=event.get("durationMs"),
                raw=bounded_raw(
                    {
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "toolName": name,
                        "isError": is_error,
                        "durationMs": event.get("durationMs"),
                        "result": _clip(text, MAX_METADATA_TEXT),
                    }
                ),
            )
        )
        self._tools.pop(call_id, None)
        return out

    def _tool_result_emission(
        self, tool: _Tool, text: str, status: str, *, update: bool, **extra: Any
    ) -> WorkerEmission:
        metadata = {
            "tool_name": tool.name,
            "tool_call_id": tool.call_id,
            "tool_output": _clip(text, MAX_METADATA_TEXT),
            **extra,
        }
        if extra.get("is_error"):
            metadata["error"] = _clip(text, 2_000)
        return WorkerEmission(
            slot=f"toolresult:{tool.call_id}",
            kind="tool_result",
            status=status,
            title=f"Tool {tool.name} result",
            description=_clip(text),
            metadata=metadata,
            update=update,
        )

    # -- misc -------------------------------------------------------------
    def _error(self, event: dict[str, Any], *, source: str = "pi") -> WorkerEmission:
        self._error_index += 1
        message = event.get("error") or event.get("errorMessage") or event.get("message") or "worker error"
        return WorkerEmission(
            slot=f"error:{self._error_index}",
            kind="worker_error",
            status="error",
            title=f"worker {self.worker} error",
            description=_clip(str(message)),
            metadata={
                "source": source,
                "raw": bounded_raw(
                    {
                        "type": event.get("type"),
                        "error": _clip(str(message), MAX_METADATA_TEXT),
                        "reason": event.get("reason"),
                    }
                ),
            },
            update=False,
        )

    def _raw_output(self, line: str) -> WorkerEmission:
        self._output_index += 1
        return WorkerEmission(
            slot=f"output:{self._output_index}",
            kind="worker_output",
            status="unknown",
            title=f"worker {self.worker} output",
            description=_clip(line),
            metadata={"raw": bounded_raw(line)},
            update=False,
        )
