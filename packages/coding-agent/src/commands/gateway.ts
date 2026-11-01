/**
 * `npi gateway` — run the NPi Bot Gateway for LabBot (macOS) and Android clients.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { gatewayHelp as commandHelp } from "../cli/command-help";
import { GATEWAY_ACTIONS, type GatewayAction, type GatewayCommandArgs, runGatewayCommand } from "../cli/gateway-cli";

export default class Gateway extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		"data-dir": Flags.string({ description: "Gateway state directory (default: ~/.omp/agent/bot-gateway)" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway manager bearer token (token)" }),
		"max-bots": Flags.integer({ description: "Maximum number of active custom bots (default: 5)" }),
		"sandbox-backend": Flags.string({
			description: "Sandbox execution backend for sandboxed bots (docker|host-unsafe)",
			options: ["docker", "host-unsafe"],
		}),
		"docker-image": Flags.string({ description: "Prebuilt worker image (default: npi-worker:withbot)" }),
		"docker-network": Flags.string({ description: "Externally firewalled bridge (default: npi-bots)" }),
		"sandbox-model-config-dir": Flags.string({
			description: "Trusted per-bot JSON models and token-free template.json directory",
		}),
		"sandbox-clients-file": Flags.string({
			description: "Auth gateway scoped clients JSON file, updated atomically",
		}),
		"sandbox-quota-root": Flags.string({ description: "XFS project-quota mount containing bot storage" }),
		"sandbox-quota-command": Flags.string({
			description: "Absolute trusted quota helper path, invoked with only bot id",
		}),
		"admin-ssh-host": Flags.string({
			description: "Optional SSH host opened by the default admin profile's /shell terminal",
		}),
		"admin-local-tools": Flags.boolean({
			description: "Allow the default admin profile (`labbot`) to run local tools and shell in its workspace",
		}),
	};

	static examples = [
		"# Boot the NPi Bot Gateway on 127.0.0.1:8651\n  npi gateway serve",
		"# Boot on a custom address and state directory\n  npi gateway serve --bind=127.0.0.1:8651 --data-dir=/var/lib/npi-gateway",
		"# Print the manager bearer token (creates one on first run)\n  npi gateway token",
		"# Rotate the manager bearer token\n  npi gateway token --regenerate",
		"# Show gateway status\n  npi gateway status",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gateway);
		if (!args.action) {
			renderCommandHelp("npi", "gateway", Gateway);
			return;
		}
		const cmd: GatewayCommandArgs = {
			action: args.action as GatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				dataDir: flags["data-dir"],
				regenerate: flags.regenerate,
				maxBots: flags["max-bots"],
				sandboxBackend: flags["sandbox-backend"] as "docker" | "host-unsafe" | undefined,
				dockerImage: flags["docker-image"],
				dockerNetwork: flags["docker-network"],
				sandboxModelConfigDir: flags["sandbox-model-config-dir"],
				sandboxClientsFile: flags["sandbox-clients-file"],
				sandboxQuotaRoot: flags["sandbox-quota-root"],
				sandboxQuotaCommand: flags["sandbox-quota-command"],
				adminSshHost: flags["admin-ssh-host"],
				adminLocalTools: flags["admin-local-tools"],
			},
		};
		await initTheme();
		await runGatewayCommand(cmd);
	}
}
