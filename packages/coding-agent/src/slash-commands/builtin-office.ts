import { runOfficeCommand } from "../office/commands";
import { readOfficeState } from "../office/company";
import {
	MAX_OFFICE_MEMBERS,
	MIN_OFFICE_MEMBERS,
	OFFICE_CAPABILITIES,
	OFFICE_COUNT,
	OFFICE_SCALES,
} from "../office/model";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_OFFICE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "office",
		description: "Virtual Office: open the panel, or run an office command",
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
		// In the TUI a bare `/office` opens the panel; with words it runs the command as everywhere else.
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			const args = command.args.split(/\s+/).filter(Boolean);
			const cwd = ctx.sessionManager.getCwd();
			clearSubmittedText(runtime);
			if (args.length > 0) {
				ctx.showStatus((await runOfficeCommand(args, ctx.settings, cwd)).text);
				return;
			}
			ctx.showOfficePanel({
				load: () => readOfficeState(ctx.settings, cwd),
				run: words => runOfficeCommand(words, ctx.settings, cwd),
				models: ctx.session
					.getAvailableModels()
					.map(model => `${model.provider}/${model.id}`)
					.sort((a, b) => a.localeCompare(b)),
				scales: OFFICE_SCALES.map(id => ({ id, offices: OFFICE_COUNT[id] })),
				capabilities: OFFICE_CAPABILITIES,
				minMembers: MIN_OFFICE_MEMBERS,
				maxMembers: MAX_OFFICE_MEMBERS,
			});
		},
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
