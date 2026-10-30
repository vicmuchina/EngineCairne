/**
 * cairn-approval: blocks configured pi tool calls until the Cairn approval queue approves.
 *
 * Enabled per chat session by the Cairn runtime: it is only loaded when
 * CAIRN_CHAT_APPROVAL_TOOLS is non-empty, which is copied into CAIRN_APPROVAL_TOOLS.
 *
 * Behaviour for a gated tool call:
 *   1. POST /projects/{id}/approvals  (action="tool_call", payload={tool_name,input,...},
 *      action_hash = sha256(canonical {action,payload}))
 *   2. long-poll GET /approvals/{id}?wait=N until approved / denied / expired / timeout
 *   3. re-verify the decision's action_hash against the hash of this exact tool call
 *   4. POST /approvals/{id}/consume with that hash — the approval is burned *before* the
 *      tool runs, so one approval can never authorise two calls
 *   5. allow only when the consume succeeded
 *
 * Fail-closed: a denied, expired, unreachable, hash-mismatched or already-consumed
 * approval blocks the tool.
 */
import { createHash } from "node:crypto";

const DEFAULT_URL = "http://127.0.0.1:8000";
const DEFAULT_WAIT = 30; // seconds per long-poll request
const DEFAULT_TIMEOUT = 180; // total seconds we wait for a decision
const POLL_PAUSE_MS = 250;

function patternToRegExp(pattern) {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function matches(patterns, name) {
	return patterns.some((pattern) => patternToRegExp(pattern).test(name));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON with recursively sorted object keys, matching Python's json.dumps(sort_keys=True). */
function canonicalJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		const body = keys
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",");
		return `{${body}}`;
	}
	return JSON.stringify(value === undefined ? null : value);
}

/** sha256(action + payload), the same binding the Python control client uses. */
function actionHash(action, payload) {
	const canonical = canonicalJson({ action, payload: payload || {} });
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function jsonFetch(url, options, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const text = await response.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = { raw: text };
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
		}
		return body;
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi) {
	const url = (process.env.CAIRN_APPROVAL_URL || DEFAULT_URL).replace(/\/+$/, "");
	const project = process.env.CAIRN_APPROVAL_PROJECT || "";
	const waitSeconds = Number(process.env.CAIRN_APPROVAL_WAIT || DEFAULT_WAIT);
	const totalTimeout = Number(process.env.CAIRN_APPROVAL_TIMEOUT || DEFAULT_TIMEOUT);
	const patterns = (process.env.CAIRN_APPROVAL_TOOLS || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (!project || patterns.length === 0) {
		return;
	}

	pi.on("tool_call", async (event) => {
		const name = event.toolName || "";
		if (name.startsWith("mcp__cairn_control__")) {
			return undefined;
		}
		if (!matches(patterns, name)) {
			return undefined;
		}

		const payload = {
			tool_name: name,
			tool_call_id: event.toolCallId || null,
			input: event.input ?? {},
			conversation_id: process.env.CAIRN_APPROVAL_CONVERSATION || null,
			project_id: project,
		};
		const expectedHash = actionHash("tool_call", payload);

		let approval;
		try {
			approval = await jsonFetch(
				`${url}/projects/${project}/approvals`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: "tool_call",
						payload,
						requested_by: `pi:${name}`,
						note: `pi wants to run ${name}`,
						expires_in: Math.ceil(totalTimeout + 60),
						action_hash: expectedHash,
					}),
				},
				15000,
			);
		} catch (error) {
			return {
				block: true,
				reason: `Approval service unavailable (${error.message}); ${name} was blocked.`,
			};
		}

		const approvalId = approval?.id;
		const deadline = Date.now() + totalTimeout * 1000;
		let status = approval?.status || "pending";
		let decision = approval;
		while (status === "pending" && Date.now() < deadline) {
			const remaining = Math.max(1, Math.min(waitSeconds, (deadline - Date.now()) / 1000));
			try {
				decision = await jsonFetch(
					`${url}/approvals/${approvalId}?wait=${remaining.toFixed(1)}`,
					{ method: "GET" },
					(remaining + 15) * 1000,
				);
			} catch (error) {
				return {
					block: true,
					reason: `Approval lookup failed (${error.message}); ${name} was blocked.`,
				};
			}
			status = decision?.status || "pending";
			if (status === "pending" && Date.now() < deadline) {
				await sleep(POLL_PAUSE_MS);
			}
		}

		if (status !== "approved") {
			const note = decision?.decision_note ? ` (${decision.decision_note})` : "";
			return {
				block: true,
				reason: `Tool call "${name}" was not approved: approval #${approvalId} is ${status}${note}.`,
			};
		}

		const storedHash = decision?.action_hash;
		if (!storedHash || storedHash !== expectedHash) {
			return {
				block: true,
				reason: `Tool call "${name}" was blocked: approval #${approvalId} is not bound to this exact tool call (hash mismatch).`,
			};
		}

		// Burn the approval *before* the tool runs: a single approval can only authorise one
		// call, and a failed consume means someone else already used it.
		try {
			const consumed = await jsonFetch(
				`${url}/approvals/${approvalId}/consume`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						consumed_by: `pi:${name}`,
						action_hash: expectedHash,
					}),
				},
				15000,
			);
			if (!consumed?.consumed_at) {
				return {
					block: true,
					reason: `Tool call "${name}" was blocked: approval #${approvalId} could not be consumed.`,
				};
			}
		} catch (error) {
			return {
				block: true,
				reason: `Tool call "${name}" was blocked: approval #${approvalId} could not be consumed (${error.message}). It may already have been used.`,
			};
		}
		return undefined;
	});
}
