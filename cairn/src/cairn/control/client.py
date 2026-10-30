from __future__ import annotations

"""Stdlib HTTP client for the Cairn control surface (used by the control MCP server).

Everything here talks to the same public REST API the UI uses; nothing reaches into the
database directly. Actions listed in ``CAIRN_APPROVAL_ACTIONS`` are gated: the request is
queued, the caller waits for a decision, and the action only runs when its approval is
``approved``, bound to this exact action payload and not yet consumed. A denied, expired,
already-consumed or mismatched decision never executes.

**Project binding.** The chat MainAgent is bound to the project of its conversation
(``CAIRN_CONTROL_PROJECT``). A caller may pass ``project_id`` but it must equal the bound
project; cross-project reads and writes are rejected before any HTTP request is made.
Path segments are percent-encoded so a project id cannot inject extra URL segments.
"""

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_URL = "http://127.0.0.1:8000"
DEFAULT_TIMEOUT = 15.0

# The MainAgent's write surface is gated by default: an approval popup must appear unless
# the operator explicitly disables the gate. ``CAIRN_APPROVAL_ACTIONS`` (a comma list)
# overrides; an explicit empty/``none`` value disables gating (documented in the policy).
DEFAULT_GATED_ACTIONS = ("add_hint", "add_intent", "set_project_status", "steer_intent")
DISABLED_ACTION_VALUES = ("", "none", "off", "disabled", "false", "0")


class ControlError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


def approval_actions() -> set[str]:
    """Control actions that require an approval.

    Unset ``CAIRN_APPROVAL_ACTIONS`` means *the default gate* (the MainAgent writes), not
    "gate nothing": a silently empty gate is what v3 shipped and it surprised the operator.
    An explicit empty value (or ``none``/``off``/``disabled``) disables the gate.
    """
    raw = os.environ.get("CAIRN_APPROVAL_ACTIONS")
    if raw is None:
        return set(DEFAULT_GATED_ACTIONS)
    if raw.strip().lower() in DISABLED_ACTION_VALUES:
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def action_hash(action: str, payload: dict[str, Any] | None) -> str:
    """Stable hash of exactly what an approval authorises."""
    canonical = json.dumps(
        {"action": action, "payload": payload or {}},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _clip(value: Any, limit: int = 400) -> Any:
    if not isinstance(value, str):
        return value
    text = " ".join(value.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _slim_fact(fact: dict[str, Any]) -> dict[str, Any]:
    return {"id": fact.get("id"), "description": _clip(fact.get("description"), 400)}


def _slim_intent(intent: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": intent.get("id"),
        "from": intent.get("from"),
        "to": intent.get("to"),
        "description": _clip(intent.get("description"), 300),
        "worker": intent.get("worker"),
        "status": "concluded" if intent.get("to") else ("working" if intent.get("worker") else "open"),
    }


def _slim_activity(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": item.get("kind"),
        "id": item.get("id"),
        "timestamp": item.get("timestamp"),
        "actor": item.get("actor"),
        "status": item.get("status"),
        "title": _clip(item.get("title"), 200),
        "description": _clip(item.get("description"), 300),
    }


class ControlClient:
    def __init__(
        self,
        base_url: str | None = None,
        project_id: str | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = (base_url or os.environ.get("CAIRN_CONTROL_URL", DEFAULT_URL)).rstrip("/")
        self.bound_project = (os.environ.get("CAIRN_CONTROL_PROJECT") or "").strip()
        self.project_id = (project_id or self.bound_project or "").strip()
        self.conversation_id = os.environ.get("CAIRN_CONTROL_CONVERSATION")
        self.timeout = timeout
        self.requested_by = os.environ.get("CAIRN_CONTROL_ACTOR", "mainagent")

    # -- transport --------------------------------------------------------
    def request(
        self, method: str, path: str, *, json_body: Any | None = None, timeout: float | None = None
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
                if not body:
                    return None
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    return body
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            detail: Any = body
            try:
                detail = json.loads(body)
            except json.JSONDecodeError:
                pass
            raise ControlError(f"{method} {path} failed ({exc.code}): {body[:500]}", exc.code, detail) from None
        except urllib.error.URLError as exc:
            raise ControlError(f"{method} {path} failed: {exc.reason}") from None

    # -- binding ----------------------------------------------------------
    def _project(self, project_id: str | None) -> str:
        """Resolve the project for this call, enforcing the conversation binding."""
        requested = (project_id or "").strip()
        if self.bound_project:
            if requested and requested != self.bound_project:
                raise ControlError(
                    "cross-project access rejected: this control session is bound to "
                    f"project {self.bound_project!r}, not {requested!r}"
                )
            return self.bound_project
        if requested:
            return requested
        if self.project_id:
            return self.project_id
        raise ControlError(
            "No project bound to this control session; pass project_id explicitly"
        )

    @staticmethod
    def _segment(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    def _project_path(self, project_id: str | None, suffix: str = "") -> str:
        return f"/projects/{self._segment(self._project(project_id))}{suffix}"

    def ensure_binding(self, project_id: str | None = None) -> str:
        """Resolve/validate the project without issuing a request (raises on cross-project)."""
        return self._project(project_id)

    # -- read -------------------------------------------------------------
    def graph_overview(self, project_id: str | None = None) -> dict[str, Any]:
        pid = self._project(project_id)
        overview = self.request("GET", f"/projects/{self._segment(pid)}/overview")
        detail = self.request("GET", f"/projects/{self._segment(pid)}")
        intents = detail.get("intents", [])
        facts = detail.get("facts", [])
        open_intents = [_slim_intent(intent) for intent in intents if intent.get("to") is None]
        goal = next((f for f in facts if f.get("id") == "goal"), None)
        recent_facts = [_slim_fact(fact) for fact in facts if fact.get("id") not in ("goal", "origin")][-10:]
        hints = [
            {"id": hint.get("id"), "creator": hint.get("creator"),
             "content": _clip(hint.get("content"), 300)}
            for hint in detail.get("hints", [])
        ]
        return {
            "project": overview["project"],
            "goal": _clip(goal.get("description"), 600) if goal else None,
            "counts": overview["counts"],
            "generated_at": overview["generated_at"],
            "workers": overview["workers"],
            "open_intents": open_intents,
            "recent_facts": recent_facts,
            "hints": hints,
            "recent_activity": [_slim_activity(item) for item in overview["recent_activity"]],
        }

    def list_activity(
        self, limit: int = 20, after: str | None = None, project_id: str | None = None
    ) -> dict[str, Any]:
        pid = self._project(project_id)
        params = {"limit": str(max(1, min(int(limit), 200)))}
        if after:
            params["after"] = after
        payload = self.request(
            "GET",
            f"/projects/{self._segment(pid)}/activity?{urllib.parse.urlencode(params)}",
        )
        return {
            "project_id": payload.get("project_id", pid),
            "next_cursor": payload.get("next_cursor"),
            "has_more": payload.get("has_more"),
            "items": [_slim_activity(item) for item in payload.get("items", [])],
        }

    # -- write ------------------------------------------------------------
    def add_hint(self, content: str, project_id: str | None = None) -> Any:
        return self.request(
            "POST",
            self._project_path(project_id, "/hints"),
            json_body={"content": content, "creator": self.requested_by},
        )

    def add_intent(
        self,
        description: str,
        from_fact_ids: list[str] | None = None,
        priority: int = 0,
        project_id: str | None = None,
    ) -> Any:
        pid = self._project(project_id)
        fact_ids = from_fact_ids
        if not fact_ids:
            # Default provenance: every fact except goal (goal may not be an intent source).
            detail = self.request("GET", f"/projects/{self._segment(pid)}")
            fact_ids = [f["id"] for f in detail.get("facts", []) if f.get("id") != "goal"]
            if not fact_ids:
                raise ControlError("Project has no usable source facts for a new intent")
        return self.request(
            "POST",
            f"/projects/{self._segment(pid)}/intents",
            json_body={
                "from": fact_ids,
                "description": description,
                "creator": self.requested_by,
                "priority": max(0, int(priority)),
            },
        )

    def set_project_status(self, status: str, project_id: str | None = None) -> Any:
        if status not in ("active", "stopped"):
            raise ControlError("status must be active or stopped")
        return self.request(
            "PUT",
            self._project_path(project_id, "/status"),
            json_body={"status": status, "actor": self.requested_by},
        )

    def steer_intent(
        self, message: str, intent_id: str | None = None, project_id: str | None = None
    ) -> Any:
        return self.request(
            "POST",
            self._project_path(project_id, "/steering"),
            json_body={
                "message": message,
                "intent_id": intent_id,
                "created_by": self.requested_by,
            },
        )

    # -- approvals --------------------------------------------------------
    def request_approval(
        self,
        action: str,
        payload: dict[str, Any] | None = None,
        note: str | None = None,
        project_id: str | None = None,
        expires_in: int | None = None,
        *,
        action_hash_value: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "action": action,
            "payload": payload or {},
            "requested_by": self.requested_by,
            "conversation_id": int(self.conversation_id) if self.conversation_id else None,
            "action_hash": action_hash_value or action_hash(action, payload),
        }
        if note:
            body["note"] = note
        if expires_in:
            body["expires_in"] = expires_in
        return self.request("POST", self._project_path(project_id, "/approvals"), json_body=body)

    def check_approval(self, approval_id: int, wait: float = 0) -> dict[str, Any]:
        query = f"?wait={wait:g}" if wait else ""
        approval = self.request(
            "GET", f"/approvals/{int(approval_id)}{query}", timeout=self.timeout + wait
        )
        self._assert_bound(approval)
        return approval

    def consume_approval(
        self, approval_id: int, expected_hash: str | None = None
    ) -> dict[str, Any]:
        """Burn the approval. The server requires the hash of the action being run."""
        body: dict[str, Any] = {"consumed_by": self.requested_by}
        if expected_hash:
            body["action_hash"] = expected_hash
        approval = self.request(
            "POST",
            f"/approvals/{int(approval_id)}/consume",
            json_body=body,
        )
        self._assert_bound(approval)
        return approval

    def _assert_bound(self, approval: Any) -> None:
        """An approval belonging to another project can never be read or consumed here."""
        if not isinstance(approval, dict):
            return
        project_id = approval.get("project_id")
        if project_id and self.bound_project and project_id != self.bound_project:
            raise ControlError(
                "cross-project access rejected: approval belongs to project "
                f"{project_id!r}, this session is bound to {self.bound_project!r}"
            )


def _wait_seconds() -> float:
    raw = os.environ.get("CAIRN_APPROVAL_WAIT", "90")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 90.0


def run_action(client: ControlClient, action: str, args: dict[str, Any]) -> dict[str, Any]:
    """Execute a control action, honouring the approval policy.

    Returns ``{"executed": bool, "status": ..., "result": ...}`` so the caller can never
    mistake a queued/denied approval for a completed action.

    Gated actions (the MainAgent writes, by default — see :func:`approval_actions`) run
    only when the approval is ``approved``, carries the ``action_hash`` of this exact
    action+args (a missing hash is refused: ``status="unbound"``), and the hash-bound
    consume call succeeds (single use).
    """
    handlers = {
        "add_hint": lambda: client.add_hint(args["content"], args.get("project_id")),
        "add_intent": lambda: client.add_intent(
            args["description"],
            args.get("from_fact_ids"),
            args.get("priority", 0),
            args.get("project_id"),
        ),
        "set_project_status": lambda: client.set_project_status(
            args["status"], args.get("project_id")
        ),
        "steer_intent": lambda: client.steer_intent(
            args["message"], args.get("intent_id"), args.get("project_id")
        ),
    }
    if action not in handlers:
        raise ControlError(f"Unknown control action: {action}")

    # Validate the binding before any approval round-trip: a cross-project (or unbound)
    # write must be rejected as such, never masked by an approval-service error.
    client.ensure_binding(args.get("project_id"))

    if action in approval_actions():
        payload = dict(args)
        expected_hash = action_hash(action, payload)
        request = client.request_approval(
            action=action,
            payload=payload,
            note=f"MainAgent wants to run {action}",
            action_hash_value=expected_hash,
        )
        approval_id = int(request["id"])
        decision = client.check_approval(approval_id, wait=_wait_seconds())
        status = decision.get("status")
        if status != "approved":
            return {
                "executed": False,
                "status": status,
                "approval_id": approval_id,
                "action": action,
                "detail": (
                    f"Action '{action}' was not executed: approval #{approval_id} is {status}. "
                    "The user must approve it in the Approvals UI."
                ),
            }
        stored_hash = decision.get("action_hash")
        if not stored_hash:
            # Fail closed: an approval that is not bound to an action must never authorise
            # one, even if the queue says "approved".
            return {
                "executed": False,
                "status": "unbound",
                "approval_id": approval_id,
                "action": action,
                "detail": (
                    f"Action '{action}' was not executed: approval #{approval_id} carries no "
                    "action_hash, so it cannot be bound to this action (fail-closed)."
                ),
            }
        if stored_hash != expected_hash:
            return {
                "executed": False,
                "status": "mismatched",
                "approval_id": approval_id,
                "action": action,
                "detail": (
                    f"Action '{action}' was not executed: approval #{approval_id} was granted "
                    "for a different action payload."
                ),
            }
        try:
            consumed = client.consume_approval(approval_id, expected_hash)
        except ControlError as exc:
            return {
                "executed": False,
                "status": "consumed",
                "approval_id": approval_id,
                "action": action,
                "detail": (
                    f"Action '{action}' was not executed: approval #{approval_id} could not be "
                    f"consumed ({exc}). It may already have been used."
                ),
            }
        result = handlers[action]()
        return {
            "executed": True,
            "status": "approved",
            "approval_id": approval_id,
            "action": action,
            "consumed_at": consumed.get("consumed_at") if isinstance(consumed, dict) else None,
            "result": result,
        }

    return {"executed": True, "status": "executed", "action": action, "result": handlers[action]()}
