/**
 * `/web --tls`: a self-signed certificate for the LAN page, made once with the system `openssl` and kept
 * under the agent dir (`web/cert.pem`, `web/key.pem`). Browsers warn about it the first time; the access
 * token still guards the page.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export interface WebTlsFiles {
	cert: string;
	key: string;
	certPath: string;
}

export async function loadOrCreateWebTls(addresses: readonly string[]): Promise<WebTlsFiles> {
	const dir = path.join(getAgentDir(), "web");
	const certPath = path.join(dir, "cert.pem");
	const keyPath = path.join(dir, "key.pem");
	try {
		const [cert, key] = await Promise.all([Bun.file(certPath).text(), Bun.file(keyPath).text()]);
		return { cert, key, certPath };
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const openssl = $which("openssl");
	if (!openssl) throw new Error("--tls needs `openssl` on PATH to make a self-signed certificate");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const san = ["DNS:localhost", "IP:127.0.0.1", ...addresses.map(address => `IP:${address}`)].join(",");
	const result =
		await $`${openssl} req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -subj /CN=npi-web -addext subjectAltName=${san} -keyout ${keyPath} -out ${certPath}`
			.quiet()
			.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`openssl could not make a certificate: ${result.stderr.toString().trim().split("\n").pop()}`);
	}
	await fs.chmod(keyPath, 0o600);
	const [cert, key] = await Promise.all([Bun.file(certPath).text(), Bun.file(keyPath).text()]);
	return { cert, key, certPath };
}
