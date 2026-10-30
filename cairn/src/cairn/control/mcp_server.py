"""Cairn control surface for the chat MainAgent.

Stdlib-only MCP server speaking JSON-RPC 2.0 over stdio (newline-delimited), so it can be
registered per-chat-session by the ``cairn-control`` pi extension without adding
dependencies. Tools mirror the public REST API; nothing here mutates the DB directly.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from cairn.control.client import ControlClient, ControlError, run_action

SERVER_NAME = "cairn-control"
SERVER_VERSION = "0.1.0"
PROTOCOL_FALLBACK = "2024-11-05"

PROJECT_SCHEMA = {
    "type": "string",
    "description": (
        "Optional, read-only tools only. Must equal the project bound to this chat "
        "session; any other value is rejected (cross-project access is not allowed)."
    ),
}

BOUND_PROJECT_NOTE = (
    " Every tool is bound to the project of this chat session; project_id cannot be used "
    "to read or write another project."
)

TOOLS: list[dict[str, Any]] = [
    {
        "name": "graph_overview",
        "description": (
            "Observe the project before answering: counts, open intents, recent facts, hints, "
            "workers and recent activity. Read-only."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": PROJECT_SCHEMA},
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "list_activity",
        "description": "Chronological project activity feed (facts, intents, hints, workers, chat).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": PROJECT_SCHEMA,
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20},
                "after": {"type": "string", "description": "Cursor from a previous response"},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "add_hint",
        "description": "Add operator guidance to the project graph (visible to reason/explore workers).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "minLength": 1},
            },
            "required": ["content"],
            "additionalProperties": False,
        },
        "annotations": {"destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "add_intent",
        "description": (
            "Propose a new research direction. Reason/explore workers execute it; you do not. "
            "from_fact_ids defaults to every non-goal fact."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "description": {"type": "string", "minLength": 1},
                "from_fact_ids": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": "integer", "minimum": 0, "default": 0},
            },
            "required": ["description"],
            "additionalProperties": False,
        },
        "annotations": {"destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "set_project_status",
        "description": "Pause (stopped) or resume (active) the autonomous dispatcher loop.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["active", "stopped"]},
            },
            "required": ["status"],
            "additionalProperties": False,
        },
        "annotations": {"destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "steer_intent",
        "description": (
            "Queue steering for a worker. Delivered at the next task boundary (task start), "
            "not mid-turn; say so if the user expects live redirection."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "minLength": 1},
                "intent_id": {"type": "string"},
            },
            "required": ["message"],
            "additionalProperties": False,
        },
        "annotations": {"destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "request_approval",
        "description": (
            "Queue an action for human approval in the Cairn UI. Does NOT execute the action; "
            "use check_approval to see the decision."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "minLength": 1},
                "payload": {"type": "object"},
                "note": {"type": "string"},
                "expires_in": {"type": "integer", "minimum": 1, "maximum": 86400},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        "annotations": {"destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "check_approval",
        "description": "Read the current decision for an approval request (optionally wait).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "approval_id": {"type": "integer", "minimum": 1},
                "wait": {"type": "number", "minimum": 0, "maximum": 120, "default": 0},
            },
            "required": ["approval_id"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
]


def _client() -> ControlClient:
    return ControlClient()


def _tool_result(payload: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    client = _client()
    try:
        if name == "graph_overview":
            return _tool_result(client.graph_overview(arguments.get("project_id")))
        if name == "list_activity":
            return _tool_result(
                client.list_activity(
                    int(arguments.get("limit", 20)),
                    arguments.get("after"),
                    arguments.get("project_id"),
                )
            )
        if name == "request_approval":
            return _tool_result(
                client.request_approval(
                    arguments["action"],
                    arguments.get("payload"),
                    arguments.get("note"),
                    arguments.get("project_id"),
                    arguments.get("expires_in"),
                )
            )
        if name == "check_approval":
            return _tool_result(
                client.check_approval(
                    int(arguments["approval_id"]), float(arguments.get("wait", 0))
                )
            )
        if name in ("add_hint", "add_intent", "set_project_status", "steer_intent"):
            outcome = run_action(client, name, arguments)
            return _tool_result(outcome, is_error=not outcome.get("executed", False))
        return _tool_result({"error": f"Unknown tool: {name}"}, is_error=True)
    except (ControlError, KeyError, ValueError) as exc:
        return _tool_result({"error": str(exc)}, is_error=True)


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    if method is None:
        return None
    if request_id is None:
        # Notification (initialized, cancelled, ...): nothing to answer.
        return None
    if method == "initialize":
        params = request.get("params") or {}
        version = params.get("protocolVersion") or PROTOCOL_FALLBACK
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "Cairn control surface for one project. Observe with "
                    "graph_overview/list_activity, steer with "
                    "add_hint/add_intent/steer_intent/set_project_status. Never invent "
                    "findings; workers do the research."
                    + BOUND_PROJECT_NOTE
                ),
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if not isinstance(name, str):
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": "tools/call requires a tool name"},
            }
        return {"jsonrpc": "2.0", "id": request_id, "result": call_tool(name, arguments)}
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(request, dict):
            continue
        response = handle(request)
        if response is None:
            continue
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
