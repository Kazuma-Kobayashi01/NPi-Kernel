import { runOfficeCommand } from "../office/commands";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_OFFICE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "office",
		description: "Virtual Office: roster, company size, and merging approved pull requests",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: [
			{ name: "on", description: "Turn Virtual Office on" },
			{ name: "off", description: "Turn Virtual Office off" },
			{ name: "scale", description: "Company size", usage: "team|studio|enterprise" },
			{ name: "size", description: "Members in an office", usage: "<office> <3-6>" },
			{ name: "add", description: "Add a worker", usage: "<office> [model] [capability]" },
			{ name: "remove", description: "Remove a worker", usage: "<name>" },
			{ name: "set", description: "Change a member", usage: "<name> model|capability|role <value>" },
			{ name: "merge", description: "Merge an approved office pull request", usage: "<pr>" },
			{ name: "reject", description: "Send an office pull request back", usage: "<pr> <reason>" },
			{ name: "memory", description: "What an office remembers about this project", usage: "<office>" },
			{ name: "remember", description: "Give an office a lesson to keep", usage: "<office> <lesson>" },
			{ name: "forget", description: "Clear an office's memory of this project", usage: "<office>" },
		],
		handle: async (command, runtime) => {
			const result = await runOfficeCommand(
				command.args.split(/\s+/).filter(Boolean),
				runtime.settings,
				runtime.cwd,
			);
			await runtime.output(result.text);
			await runtime.notifyConfigChanged?.();
			return commandConsumed({ failed: result.failed });
		},
	},
];
