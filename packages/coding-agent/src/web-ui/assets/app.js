// NPi `/web` page: one session, streamed over a WebSocket from the npi process that printed the link.
// Plain script, no build step; it is embedded in the npi binary and served with a strict CSP.
(() => {
	"use strict";

	const $ = id => document.getElementById(id);
	const transcript = $("transcript");
	const input = $("input");
	const sendBtn = $("send");
	const queueBtn = $("queueBtn");
	const stopBtn = $("stop");
	const conn = $("conn");
	const dialogsEl = $("dialogs");

	let ws = null;
	let retry = 0;
	let reqSeq = 0;
	const pending = new Map();
	let state = { isStreaming: false };
	/** Tool cards by tool call id, so results and streamed output land on their call. */
	const tools = new Map();
	/** The assistant message being streamed, and its element. */
	let live = null;
	const dialogs = new Map();

	// ---------- rendering helpers ----------

	function el(tag, cls, text) {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function textOf(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map(part => (part && part.type === "text" ? part.text : part && part.type === "image" ? "[image]" : ""))
			.filter(Boolean)
			.join("\n");
	}

	/** Minimal markdown: fenced code blocks, inline code, paragraphs. Text only; never HTML. */
	function renderMarkdown(target, text) {
		target.textContent = "";
		const parts = String(text).split(/```/);
		parts.forEach((part, index) => {
			if (index % 2 === 1) {
				const newline = part.indexOf("\n");
				const code = newline >= 0 ? part.slice(newline + 1) : part;
				const pre = el("pre");
				pre.appendChild(el("code", "", code.replace(/\n$/, "")));
				target.appendChild(pre);
				return;
			}
			for (const para of part.split(/\n{2,}/)) {
				if (!para.trim()) continue;
				const p = el("p");
				const bits = para.split(/`([^`\n]+)`/);
				bits.forEach((bit, i) => p.appendChild(i % 2 ? el("code", "", bit) : document.createTextNode(bit)));
				target.appendChild(p);
			}
		});
	}

	function argPreview(args) {
		if (!args || typeof args !== "object") return "";
		const first =
			args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url ?? args.description;
		const value = typeof first === "string" ? first : JSON.stringify(args);
		return value.length > 120 ? `${value.slice(0, 120)}…` : value;
	}

	function nearBottom() {
		return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	}

	function scrollIfFollowing(follow) {
		if (follow) transcript.scrollTop = transcript.scrollHeight;
	}

	function toolCard(call) {
		let card = tools.get(call.id);
		if (card) {
			if (call.arguments) card.setArgs(call.arguments);
			return card.node;
		}
		const node = el("details", "tool run");
		const summary = el("summary");
		const name = el("span", "name", call.name || "tool");
		const arg = el("span", "arg");
		summary.append(name, document.createTextNode(" "), arg);
		const argsPre = el("pre");
		const outPre = el("pre");
		outPre.hidden = true;
		node.append(summary, argsPre, outPre);
		card = {
			node,
			setArgs(args) {
				arg.textContent = argPreview(args);
				argsPre.textContent = JSON.stringify(args, null, 2);
			},
			setOutput(text, done, isError) {
				if (text) {
					outPre.hidden = false;
					outPre.textContent = text;
				}
				if (done) node.classList.remove("run");
				if (isError) node.classList.add("err");
			},
		};
		card.setArgs(call.arguments || {});
		tools.set(call.id, card);
		return node;
	}

	function renderAssistant(target, message) {
		target.textContent = "";
		for (const block of message.content || []) {
			if (!block) continue;
			if (block.type === "text" && block.text) {
				const div = el("div", "text");
				renderMarkdown(div, block.text);
				target.appendChild(div);
			} else if (block.type === "thinking" && block.thinking) {
				const details = el("details", "thinking");
				details.append(el("summary", "", "Thinking"), el("div", "think", block.thinking));
				target.appendChild(details);
			} else if (block.type === "toolCall") {
				target.appendChild(toolCard(block));
			}
		}
		if (message.stopReason === "error" && message.errorMessage) {
			target.appendChild(el("div", "msg error", message.errorMessage));
		}
	}

	function appendMessage(message) {
		if (!message || typeof message !== "object") return null;
		const role = message.role;
		if (role === "toolResult") {
			const card = tools.get(message.toolCallId);
			if (card) card.setOutput(textOf(message.content), true, message.isError);
			return null;
		}
		if (role === "user") {
			const wrap = el("div", "msg user");
			wrap.appendChild(el("div", "body", textOf(message.content)));
			transcript.appendChild(wrap);
			return wrap;
		}
		if (role === "assistant") {
			const wrap = el("div", "msg assistant");
			renderAssistant(wrap, message);
			transcript.appendChild(wrap);
			return wrap;
		}
		const text = textOf(message.content) || message.summary || "";
		if (!text) return null;
		const wrap = el("div", "msg note", text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
		transcript.appendChild(wrap);
		return wrap;
	}

	function resetTranscript(messages) {
		transcript.textContent = "";
		tools.clear();
		live = null;
		for (const message of messages || []) appendMessage(message);
		transcript.scrollTop = transcript.scrollHeight;
	}

	function toast(message, type) {
		const node = el("div", `toast ${type || ""}`, message);
		$("toasts").appendChild(node);
		setTimeout(() => node.remove(), 6000);
	}

	// ---------- state ----------

	function applyState(next) {
		if (!next) return;
		state = Object.assign({}, state, next);
		const model = state.model ? state.model.name || state.model.id : "no model";
		const bits = [state.sessionName, model, state.thinkingLevel ? `thinking ${state.thinkingLevel}` : null];
		$("meta").textContent = bits.filter(Boolean).join(" · ");
		setStreaming(state.isStreaming);
		const queue = $("queue");
		const queued = state.queuedMessages || { steering: [], followUp: [] };
		const all = [...(queued.steering || []), ...(queued.followUp || [])];
		queue.textContent = "";
		queue.hidden = all.length === 0;
		if (all.length) {
			queue.appendChild(document.createTextNode("Queued: "));
			for (const text of all) queue.appendChild(el("span", "chip", text.length > 80 ? `${text.slice(0, 80)}…` : text));
		}
	}

	function setStreaming(streaming) {
		state.isStreaming = !!streaming;
		stopBtn.hidden = !state.isStreaming;
		queueBtn.hidden = !state.isStreaming;
		sendBtn.textContent = state.isStreaming ? "Steer" : "Send";
		sendBtn.title = state.isStreaming ? "Steer the current turn" : "";
		if (ws && ws.readyState === WebSocket.OPEN) {
			conn.textContent = state.isStreaming ? "working" : "connected";
			conn.className = `conn ${state.isStreaming ? "busy" : "on"}`;
		}
	}

	let stateTimer = null;
	function refreshState() {
		clearTimeout(stateTimer);
		stateTimer = setTimeout(() => {
			rpc({ type: "get_state" }).then(applyState, () => {});
		}, 150);
	}

	// ---------- events ----------

	function onEvent(frame) {
		if (!frame || typeof frame.type !== "string") return;
		const follow = nearBottom();
		switch (frame.type) {
			case "agent_start":
				setStreaming(true);
				break;
			case "agent_end":
			case "session_settled":
				setStreaming(false);
				refreshState();
				break;
			case "message_start":
				if (frame.message && frame.message.role === "assistant") {
					live = { node: appendMessage(frame.message) };
				} else {
					appendMessage(frame.message);
				}
				break;
			case "message_update":
				if (frame.message && frame.message.role === "assistant") {
					if (!live || !live.node) live = { node: appendMessage(frame.message) };
					else renderAssistant(live.node, frame.message);
				}
				break;
			case "message_end":
				if (frame.message && frame.message.role === "assistant") {
					if (live && live.node) renderAssistant(live.node, frame.message);
					else appendMessage(frame.message);
					live = null;
				}
				break;
			case "tool_execution_start": {
				if (!tools.has(frame.toolCallId)) {
					transcript.appendChild(toolCard({ id: frame.toolCallId, name: frame.toolName, arguments: frame.args }));
				}
				break;
			}
			case "tool_execution_update": {
				const card = tools.get(frame.toolCallId);
				if (card && frame.partialResult) card.setOutput(textOf(frame.partialResult.content), false, false);
				break;
			}
			case "tool_execution_end": {
				const card = tools.get(frame.toolCallId);
				if (card) card.setOutput(frame.result ? textOf(frame.result.content) : "", true, frame.isError);
				break;
			}
			case "queue_update":
				refreshState();
				break;
			case "prompt_result":
				if (frame.status === "error" && frame.error) toast(frame.error.message || "Prompt failed", "error");
				break;
			default:
				break;
		}
		scrollIfFollowing(follow);
	}

	// ---------- dialogs ----------

	function answer(id, response) {
		send({ kind: "ui_response", response: Object.assign({ id }, response) }, true).then(
			() => removeDialog(id),
			error => {
				toast(String(error.message || error), "error");
				removeDialog(id);
			},
		);
	}

	function removeDialog(id) {
		const node = dialogs.get(id);
		if (node) node.remove();
		dialogs.delete(id);
	}

	function cancelButton(id, label) {
		const button = el("button", "", label || "Cancel");
		button.addEventListener("click", () => answer(id, { cancelled: true }));
		return button;
	}

	function showDialog(request) {
		if (!request || !request.id) return;
		switch (request.method) {
			case "cancel":
				removeDialog(request.targetId);
				return;
			case "notify":
				toast(request.message, request.notifyType);
				return;
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "ask":
				break;
			default:
				return;
		}
		if (dialogs.has(request.id)) return;
		const box = el("div", "dialog");
		const id = request.id;
		if (request.method === "select") {
			box.appendChild(el("h3", "", request.title));
			const opts = el("div", "opts");
			(request.options || []).forEach((option, index) => {
				const detail = (request.optionDetails || [])[index];
				const button = el("button", "opt", option);
				if (detail && detail.description) button.appendChild(el("span", "desc", detail.description));
				button.addEventListener("click", () => answer(id, { value: option }));
				opts.appendChild(button);
			});
			box.appendChild(opts);
			const row = el("div", "row");
			row.appendChild(cancelButton(id));
			box.appendChild(row);
		} else if (request.method === "confirm") {
			box.appendChild(el("h3", "", request.title));
			if (request.message) box.appendChild(el("div", "msgtext", request.message));
			const row = el("div", "row");
			const no = el("button", "", "No");
			no.addEventListener("click", () => answer(id, { confirmed: false }));
			const yes = el("button", "primary", "Yes");
			yes.addEventListener("click", () => answer(id, { confirmed: true }));
			row.append(no, yes);
			box.appendChild(row);
		} else if (request.method === "input" || request.method === "editor") {
			box.appendChild(el("h3", "", request.title));
			const field = request.method === "input" ? el("input") : el("textarea");
			if (request.method === "input") {
				field.type = request.secret ? "password" : "text";
				field.placeholder = request.placeholder || "";
			} else {
				field.rows = 6;
				field.value = request.prefill || "";
			}
			box.appendChild(field);
			const row = el("div", "row");
			const ok = el("button", "primary", "Submit");
			ok.addEventListener("click", () => answer(id, { value: field.value }));
			row.append(cancelButton(id), ok);
			box.appendChild(row);
		} else if (request.method === "ask") {
			const readers = [];
			for (const question of request.questions || []) {
				const q = el("div", "q");
				q.appendChild(el("h3", "", question.question || question.header || ""));
				const name = `q_${id}_${question.id}`;
				const inputs = [];
				(question.options || []).forEach((option, index) => {
					const label = el("label");
					const box2 = el("input");
					box2.type = question.multi ? "checkbox" : "radio";
					box2.name = name;
					box2.value = option.label;
					if (question.recommended === index) box2.checked = !question.multi;
					label.append(box2, document.createTextNode(` ${option.label}`));
					if (option.description) label.appendChild(el("span", "desc", option.description));
					q.appendChild(label);
					inputs.push(box2);
				});
				const custom = el("input");
				custom.type = "text";
				custom.placeholder = "Other (optional)";
				q.appendChild(custom);
				box.appendChild(q);
				readers.push(() => {
					const answer = {
						id: question.id,
						selectedOptions: inputs.filter(i => i.checked).map(i => i.value),
					};
					if (custom.value.trim()) answer.customInput = custom.value.trim();
					return answer;
				});
			}
			const row = el("div", "row");
			const ok = el("button", "primary", "Submit");
			ok.addEventListener("click", () => answer(id, { answers: readers.map(read => read()) }));
			row.append(cancelButton(id), ok);
			box.appendChild(row);
		}
		dialogs.set(id, box);
		dialogsEl.appendChild(box);
		box.scrollIntoView({ block: "nearest" });
	}

	// ---------- socket ----------

	function send(payload, expectReply) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
		if (!expectReply) {
			ws.send(JSON.stringify(payload));
			return Promise.resolve();
		}
		const reqId = `r${++reqSeq}`;
		const result = new Promise((resolve, reject) => pending.set(reqId, { resolve, reject }));
		ws.send(JSON.stringify(Object.assign({ reqId }, payload)));
		return result;
	}

	function rpc(command) {
		return send({ kind: "rpc", command }, true);
	}

	function connect() {
		const scheme = location.protocol === "https:" ? "wss" : "ws";
		ws = new WebSocket(`${scheme}://${location.host}/ws`);
		ws.addEventListener("open", () => {
			retry = 0;
			conn.textContent = "connected";
			conn.className = "conn on";
		});
		ws.addEventListener("message", event => {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			switch (msg.kind) {
				case "hello":
					$("cwd").textContent = msg.cwd || "";
					document.title = `NPi · ${(msg.cwd || "").split("/").pop() || "Web"}`;
					for (const node of dialogs.values()) node.remove();
					dialogs.clear();
					resetTranscript(msg.messages);
					applyState(msg.state);
					for (const request of msg.pendingDialogs || []) showDialog(request);
					break;
				case "event":
					onEvent(msg.frame);
					break;
				case "ui":
					showDialog(msg.request);
					break;
				case "ui_resolved":
					removeDialog(msg.id);
					break;
				case "result": {
					const waiter = pending.get(msg.reqId);
					if (!waiter) break;
					pending.delete(msg.reqId);
					if (msg.ok) waiter.resolve(msg.data);
					else waiter.reject(new Error(msg.error || "Failed"));
					break;
				}
				case "error":
					toast(msg.message, "error");
					break;
				default:
					break;
			}
		});
		ws.addEventListener("close", event => {
			for (const waiter of pending.values()) waiter.reject(new Error("Disconnected"));
			pending.clear();
			conn.textContent = "offline";
			conn.className = "conn off";
			if (event.code === 1001 && event.reason === "Server stopped") {
				toast("The web UI was stopped in the terminal.", "warning");
				return;
			}
			const delay = Math.min(15000, 500 * 2 ** retry++);
			setTimeout(connect, delay);
		});
	}

	// ---------- composer ----------

	function submit(mode) {
		const message = input.value;
		if (!message.trim()) return;
		let command;
		if (!state.isStreaming) command = { type: "prompt", message };
		else if (mode === "queue") command = { type: "follow_up", message };
		else command = { type: "steer", message };
		input.value = "";
		rpc(command).then(refreshState, error => {
			input.value = message;
			toast(String(error.message || error), "error");
		});
	}

	sendBtn.addEventListener("click", () => submit("send"));
	queueBtn.addEventListener("click", () => submit("queue"));
	stopBtn.addEventListener("click", () => {
		rpc({ type: "abort" }).catch(error => toast(String(error.message || error), "error"));
	});
	input.addEventListener("keydown", event => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit("send");
		}
	});

	connect();
})();
