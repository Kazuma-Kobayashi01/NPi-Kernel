/**
 * Manage signed-in OAuth accounts from a shell: the same list, activation and names as `/account`.
 * Hosts (the desktop app's Settings → Accounts) read and change accounts through it with `--json`.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import { accountHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { formatAccountRows, listAccountRows } from "../slash-commands/helpers/accounts";

const USAGE =
	"Usage: npi account [--json] | activate <provider> <id> | rotate <provider> | rename <provider> <id> [name]";

export default class Account extends Command {
	static description = commandHelp.description;
	static strict = false;

	static flags = {
		json: Flags.boolean({ char: "j", description: "Print the accounts as JSON", default: false }),
	};

	static examples = [
		"npi account",
		"npi account --json",
		"npi account activate anthropic 12",
		"npi account rotate anthropic",
		"npi account rename openai-codex 7 GPT-Plus-Kazuma",
		"npi account rename openai-codex 7",
	];

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Account);
		const [verb, provider, idText, ...nameWords] = argv.map(String);
		const settings = await Settings.loadReadOnly();
		const authStorage = await discoverAuthStorage(undefined, { settings });
		try {
			await authStorage.credentials.reload();
			const credentialId = idText === undefined ? undefined : Number(idText);
			const needsId = verb === "activate" || verb === "rename";
			if (verb !== undefined && !["activate", "rotate", "rename"].includes(verb)) {
				throw new Error(USAGE);
			}
			if (verb !== undefined && !provider) throw new Error(USAGE);
			if (needsId && !Number.isInteger(credentialId)) throw new Error(USAGE);
			if (verb === "activate") authStorage.oauth.activate(provider!, credentialId!);
			else if (verb === "rotate") authStorage.oauth.activate(provider!, undefined);
			else if (verb === "rename") {
				const name = nameWords.join(" ").trim();
				authStorage.oauth.setLabel(provider!, credentialId!, name && name !== "-" ? name : undefined);
			}
			const rows = await listAccountRows(authStorage, undefined, formatProviderName);
			console.log(flags.json ? JSON.stringify(rows, null, 2) : formatAccountRows(rows));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		} finally {
			authStorage.close();
		}
	}
}
