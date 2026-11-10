/**
 * Manage the Virtual Office from a shell: the same commands as `/office` in a session.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { officeHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { runOfficeCommand } from "../office/commands";
import { readOfficeState } from "../office/company";

export default class Office extends Command {
	static description = commandHelp.description;
	static strict = false;

	static flags = {
		json: Flags.boolean({ char: "j", description: "Print the company state as JSON", default: false }),
	};

	static examples = [
		"npi office",
		"npi office on",
		"npi office scale studio",
		"npi office size 1 5",
		"npi office set Worker-1a2b3c model anthropic/claude-sonnet-5-5",
		"npi office set Worker-1a2b3c capability expert",
		"npi office merge 4",
		"npi office --json",
	];

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Office);
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const result = await runOfficeCommand(argv.map(String), settings, cwd);
		await settings.flush();
		if (flags.json && !result.failed) {
			console.log(JSON.stringify(await readOfficeState(settings, cwd), null, 2));
		} else if (result.failed) {
			console.error(result.text);
			process.exitCode = 1;
		} else {
			console.log(result.text);
		}
	}
}
