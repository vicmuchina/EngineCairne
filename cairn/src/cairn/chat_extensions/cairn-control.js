/**
 * cairn-control: registers the `cairn-control` MCP server for this pi session only.
 *
 * Loaded by the Cairn chat runtime with `--extension <this file>`; it is not installed
 * globally, so the user's other pi sessions are unaffected. The MCP server is a stdlib
 * Python stdio process (`python -m cairn.control.mcp_server`) that talks to the same
 * Cairn HTTP API the UI uses.
 */
export default function (pi) {
	const url = process.env.CAIRN_CONTROL_URL || "http://127.0.0.1:8000";
	const project = process.env.CAIRN_CONTROL_PROJECT || "";
	const python = process.env.CAIRN_CONTROL_PYTHON || "python3";

	// Pass the approval configuration through *unset* when it is unset in this process:
	// the control MCP server treats "unset" as "use the default gate" and an explicit
	// empty string as "gate nothing". Forcing "" here would silently disable approvals.
	const approvalEnv =
		process.env.CAIRN_APPROVAL_ACTIONS === undefined
			? {}
			: { CAIRN_APPROVAL_ACTIONS: process.env.CAIRN_APPROVAL_ACTIONS };

	pi.registerMcpServer("cairn-control", {
		type: "stdio",
		command: python,
		args: ["-m", "cairn.control.mcp_server"],
		env: {
			CAIRN_CONTROL_URL: url,
			CAIRN_CONTROL_PROJECT: project,
			CAIRN_CONTROL_CONVERSATION: process.env.CAIRN_CONTROL_CONVERSATION || "",
			CAIRN_CONTROL_ROOT: process.env.CAIRN_CONTROL_ROOT || "",
			CAIRN_CONTROL_ACTOR: process.env.CAIRN_CONTROL_ACTOR || "mainagent",
			...approvalEnv,
			CAIRN_APPROVAL_WAIT: process.env.CAIRN_APPROVAL_WAIT || "90",
		},
		description: "Cairn project graph: observe the fact graph and steer workers.",
		// Declare the tools directly to the model: the MainAgent's job is to observe and
		// steer, so these should not be hidden behind codemode/tool_search.
		exposure: "direct",
		timeout: 120,
	});
}
