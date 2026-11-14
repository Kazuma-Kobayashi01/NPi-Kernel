/**
 * What `/rc` prints about a running remote control. Kept apart from `remote-control.ts` so the slash-command
 * registry can show it without loading the RPC server.
 */
import { theme } from "@oh-my-pi/pi-tui/theme";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { RemoteControl } from "./remote-control";

export function remoteControlStatus(control: RemoteControl): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const where =
		control.transport.kind === "relay"
			? `via ${control.transport.url}`
			: `on ws://${control.transport.hostname}:${control.transport.port}`;
	return [
		theme.fg("success", `Remote control on ${where}`),
		` ${bullet} ${theme.fg("muted", `Open this session on a paired phone (NPi Remote) to send prompts and answer approvals.`)}`,
		` ${bullet} ${theme.fg("muted", `Phones see only this session (${shortenPath(control.cwd)}).`)}`,
		theme.fg("dim", "Dialogs show on both sides; the first answer wins. /rc off to stop."),
	].join("\n");
}
