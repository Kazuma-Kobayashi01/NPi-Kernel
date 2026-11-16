/**
 * What `/web` prints about a running web UI. Kept apart from `web-ui.ts` so the slash-command registry can
 * show it without loading the RPC server.
 */
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { WebUi } from "./web-ui";

export function webUiStatus(control: WebUi): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const pages = control.connections;
	return [
		theme.fg("success", `Web UI on (${pages === 1 ? "1 page open" : `${pages} pages open`})`),
		...control.urls().map(url => ` ${bullet} ${theme.fg("accent", url)}`),
		` ${bullet} ${theme.fg("muted", `Browsers see only this session (${shortenPath(control.cwd)}); anyone with the link can drive it.`)}`,
		theme.fg("dim", "Dialogs show on both sides; the first answer wins. /web stop to stop."),
	].join("\n");
}
