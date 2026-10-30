#!/usr/bin/env python3
"""
Fake ``pi --mode rpc`` server used by the Cairn runtime v3 tests.

Speaks the documented protocol: JSONL commands on stdin, ``response`` records and session
events on stdout, diagnostics on stderr. Behaviour is driven by CAIRN_TEST_RPC_* env vars so
one stub can cover turn completion, mid-turn steering, crashes, protocol contamination,
backpressure and response/event interleaving.

CAIRN_TEST_RPC_MODE:
    ok          normal turn (default)
    slow        streams until a steer arrives (or CAIRN_TEST_RPC_MAX_SECONDS), then answers
    nosettle    emits agent_end but never agent_settled
    noresponse  reads the prompt and answers nothing (startup/prompt timeout)
    crash       exits mid-turn with code 9
    garbage     writes non-protocol lines and U+2028 inside a JSON string, then a real turn
    flood       emits CAIRN_TEST_RPC_LINES deltas as fast as possible
    detached    emits agent_settled immediately, then keeps emitting events (late events)
    aborted     completes a turn but reports agent_settled{aborted:true} (no local abort)
    nostart     delays agent_start after accepting the prompt (abort-before-start window)
    stubborn    keeps streaming and ignores abort until its own deadline
    silent      completes a turn without producing any assistant message
    secondsilent normal first turn, silent from the second turn on (per-turn text test)
    queued      streams without ever consuming the steering queue (clear_queue test)
    handled     answers the prompt with disposition=handled (no run)

CAIRN_TEST_RPC_GETSTATE_DELAY delays get_state responses (seconds), which widens the
"stop arrived while the session was starting" window for the abort tests.
"""

import json
import os
import sys
import threading
import time

LOCK = threading.Lock()
STATE = {
    "last_text": "",
    "steering": [],
    "is_streaming": False,
    "settled": 0,
    "turn": 0,
    "closing": False,
    "abort_requested": False,
}
MODE = os.environ.get("CAIRN_TEST_RPC_MODE", "ok")
TEXT = os.environ.get("CAIRN_TEST_RPC_TEXT", "CAIRN_RPC_OK")
STEP = float(os.environ.get("CAIRN_TEST_RPC_STEP_DELAY", "0.02"))
MAX_SECONDS = float(os.environ.get("CAIRN_TEST_RPC_MAX_SECONDS", "8"))
LINES = int(os.environ.get("CAIRN_TEST_RPC_LINES", "2000"))
LOG_PATH = os.environ.get("CAIRN_TEST_RPC_LOG")
PRE_START = float(os.environ.get("CAIRN_TEST_RPC_PRE_START_SECONDS", "1.0"))
GETSTATE_DELAY = float(os.environ.get("CAIRN_TEST_RPC_GETSTATE_DELAY", "0"))


def log(record):
    if not LOG_PATH:
        return
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def emit(payload):
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    with LOCK:
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            STATE["closing"] = True


def respond(command_id, command, *, data=None, success=True, error=None):
    record = {"type": "response", "command": command, "success": success}
    if command_id is not None:
        record["id"] = command_id
    if success and data is not None:
        record["data"] = data
    if not success:
        record["error"] = error or "failed"
    emit(record)


def user_message(text):
    return {"role": "user", "content": [{"type": "text", "text": text}], "timestamp": 1}


def assistant_message(text, stop_reason="stop"):
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "api": "test",
        "provider": "test",
        "model": "fake-rpc",
        "usage": {"input": 11, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                  "totalTokens": 14,
                  "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        "stopReason": stop_reason,
        "timestamp": 2,
    }


def run_turn(prompt_text):
    """Emit one full turn on this fake session."""
    STATE["turn"] += 1
    if MODE == "nostart":
        # The prompt was accepted but the run has not started yet: this is the window in
        # which a stop must not be a no-op.
        deadline = time.time() + PRE_START
        while time.time() < deadline:
            if STATE["abort_requested"]:
                return
            time.sleep(0.02)
    STATE["is_streaming"] = True
    emit({"type": "agent_start"})
    emit({"type": "turn_start"})
    emit({"type": "message_start", "message": user_message(prompt_text)})
    emit({"type": "message_end", "message": user_message(prompt_text)})
    silent = MODE == "silent" or (MODE == "secondsilent" and STATE["turn"] >= 2)
    if silent:
        emit({"type": "agent_end", "messages": [], "willRetry": False})
        STATE["is_streaming"] = False
        STATE["settled"] += 1
        emit({"type": "agent_settled", "aborted": False})
        return
    emit({"type": "message_start", "message": assistant_message("")})

    if MODE == "garbage":
        garbage_prefix()

    if MODE == "crash":
        emit({"type": "message_update",
              "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "par"}})
        log({"event": "crash", "pid": os.getpid()})
        os._exit(9)

    if MODE == "flood":
        for index in range(LINES):
            emit({"type": "message_update",
                  "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0,
                                            "delta": f"{index},"}})
        text = "flood-done"
    elif MODE in ("slow", "stubborn", "queued"):
        deadline = time.time() + MAX_SECONDS
        text = ""
        while time.time() < deadline:
            if MODE == "slow" and STATE["steering"]:
                text = STATE["steering"].pop(0)
                break
            emit({"type": "message_update",
                  "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0,
                                            "delta": "working "}})
            time.sleep(STEP)
        if not text:
            text = "slow-timeout"
    else:
        for chunk in ("CAIRN", "_RPC", "_OK"):
            emit({"type": "message_update",
                  "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0,
                                            "delta": chunk}})
            time.sleep(STEP)
        text = TEXT

    message = assistant_message(text, "aborted" if MODE == "aborted" else "stop")
    STATE["last_text"] = text
    emit({"type": "message_update",
          "assistantMessageEvent": {"type": "text_end", "contentIndex": 0, "content": text}})
    emit({"type": "message_end", "message": message})
    emit({"type": "turn_end", "message": message, "toolResults": []})
    emit({"type": "agent_end", "messages": [message], "willRetry": False})
    STATE["is_streaming"] = False
    if MODE != "nosettle":
        STATE["settled"] += 1
        emit({"type": "agent_settled",
              "aborted": STATE["abort_requested"] or MODE == "aborted"})
    if MODE == "detached":
        # A settled turn followed by unrelated late events: they must not be attributed to
        # the finished run's completion decision.
        emit({"type": "session_info_changed", "name": "late-event"})


def start_turn(prompt_text):
    thread = threading.Thread(target=_turn_guard, args=(prompt_text,), daemon=True)
    thread.start()


def _turn_guard(prompt_text):
    try:
        run_turn(prompt_text)
    except Exception as exc:  # pragma: no cover - stub diagnostics
        sys.stderr.write(f"fake pi rpc error: {exc}\n")


def garbage_prefix():
    """Contaminate stdout with a non-protocol line, then a U+2028 inside a JSON string."""
    with LOCK:
        sys.stdout.write("this line is not json\n")
        sys.stdout.flush()
    emit({"type": "message_update",
          "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0,
                                    "delta": "unicode\u2028separator "}})


def main():
    agents = []
    for name in ("AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"):
        candidate = os.path.join(os.getcwd(), name)
        try:
            with open(candidate, encoding="utf-8") as handle:
                agents.append([name, handle.read()])
        except OSError:
            continue
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or ""
    try:
        agent_files = sorted(os.listdir(agent_dir)) if agent_dir else []
    except OSError:
        agent_files = []
    log({"event": "spawn", "pid": os.getpid(), "argv": sys.argv[1:], "mode": MODE,
         "cwd": os.getcwd(), "agents": agents, "agent_dir": agent_dir,
         "agent_files": agent_files})
    sys.stderr.write("fake pi rpc ready\n")
    sys.stderr.flush()

    if MODE == "stale":
        STATE["steering"].append("STALE_INSTRUCTION")

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except json.JSONDecodeError:
            log({"event": "bad_command", "raw": line[:200]})
            emit({"type": "response", "command": "parse", "success": False,
                  "error": "Failed to parse command"})
            continue
        command_type = command.get("type")
        command_id = command.get("id")
        log({"event": "command", "type": command_type, "id": command_id,
             "message": command.get("message")})
        if command_type == "prompt":
            if MODE == "noresponse":
                continue
            if MODE == "handled":
                respond(command_id, "prompt", data={"disposition": "handled"})
                continue
            STATE["abort_requested"] = False
            respond(command_id, "prompt", data={"disposition": "started"})
            start_turn(command.get("message", ""))
        elif command_type == "steer":
            STATE["steering"].append(command.get("message", ""))
            emit({"type": "queue_update", "steering": [command.get("message", "")],
                  "followUp": []})
            respond(command_id, "steer", data={"disposition": "queued"})
        elif command_type == "follow_up":
            STATE["steering"].append(command.get("message", ""))
            respond(command_id, "follow_up", data={"disposition": "queued"})
        elif command_type == "abort":
            STATE["abort_requested"] = True
            if MODE != "stubborn":
                # A stubborn turn keeps streaming: the abort is acknowledged but the run
                # only ends at its own deadline (used to test the "no 200 lie" path).
                STATE["is_streaming"] = False
            respond(command_id, "abort")
        elif command_type == "get_state":
            if GETSTATE_DELAY:
                time.sleep(GETSTATE_DELAY)
            respond(command_id, "get_state", data={
                "isStreaming": STATE["is_streaming"],
                "isCompacting": False,
                "sessionId": "fake-rpc-session",
                "sessionFile": "/tmp/fake-rpc-session.jsonl",
                "messageCount": STATE["turn"] * 2,
                "pendingMessageCount": len(STATE["steering"]),
                "aborted": STATE["abort_requested"],
            })
        elif command_type == "get_last_assistant_text":
            respond(command_id, "get_last_assistant_text", data={"text": STATE["last_text"]})
        elif command_type == "clear_queue":
            steering = STATE["steering"][:]
            STATE["steering"].clear()
            log({"event": "cleared", "steering": steering})
            respond(command_id, "clear_queue", data={"steering": steering, "followUp": []})
        else:
            respond(command_id, command_type, success=False,
                    error=f"unknown command {command_type}")
        if command_type == "abort" and MODE != "stubborn":
            STATE["settled"] += 1
            emit({"type": "agent_end", "messages": [], "willRetry": False})
            emit({"type": "agent_settled", "aborted": True})
    log({"event": "exit", "pid": os.getpid()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
