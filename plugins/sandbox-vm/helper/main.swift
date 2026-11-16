// npi-vm-helper: owns the Linux virtual machine for the sandbox-vm plugin.
//
// Three modes:
//   npi-vm-helper                  speaks the plugin's line protocol (src/protocol.ts) on stdin/stdout
//   npi-vm-helper run <options>    boots a guest with its console on this terminal (image building)
//   npi-vm-helper attach <socket>  a terminal inside a running guest: the client of the terminal socket below
//
// With `terminalSocket` in the start config the helper also listens on that unix socket (owner only): each
// connection gets an interactive bash on a pty in the guest (`pty-*` ops of guest/agent.py). The wire is one JSON
// object per line, bytes base64: {t:open,cols,rows,cwd,term} {t:in,d} {t:resize,cols,rows} to the helper,
// {t:out,d} {t:exit,code} back.
//
// The guest's command agent (guest/agent.py) speaks the same protocol over a second virtio console port, so
// exec/cancel/release lines are relayed to it unchanged and its answers come back unchanged.

import Foundation
import Virtualization

// MARK: - Output

let outputLock = NSLock()

/// One JSON object per line on stdout; the protocol channel.
func emit(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
	outputLock.lock()
	defer { outputLock.unlock() }
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write(Data([0x0a]))
}

func log(_ text: String) {
	FileHandle.standardError.write((text + "\n").data(using: .utf8) ?? Data())
}

// MARK: - Configuration

struct Mount {
	var path: String
	var readOnly: Bool
}

struct GuestSpec {
	var kernel: String
	var initrd: String
	var cmdline: String
	var memoryMiB: Int
	var cpus: Int
	var nat: Bool
	var mounts: [Mount]
	var disk: String?
}

struct HelperError: Error, CustomStringConvertible {
	var description: String
	init(_ description: String) { self.description = description }
}

/// The console and the agent channel: pipes the host side reads and writes.
final class Channels {
	let consoleIn = Pipe()
	let consoleOut = Pipe()
	let agentIn = Pipe()
	let agentOut = Pipe()
}

func makeConfiguration(_ spec: GuestSpec, channels: Channels) throws -> VZVirtualMachineConfiguration {
	let config = VZVirtualMachineConfiguration()
	config.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount, min(spec.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
	config.memorySize = min(
		VZVirtualMachineConfiguration.maximumAllowedMemorySize,
		max(VZVirtualMachineConfiguration.minimumAllowedMemorySize, UInt64(spec.memoryMiB) * 1_048_576))
	let loader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: spec.kernel))
	loader.initialRamdiskURL = URL(fileURLWithPath: spec.initrd)
	loader.commandLine = spec.cmdline
	config.bootLoader = loader
	config.platform = VZGenericPlatformConfiguration()

	let console = VZVirtioConsoleDeviceSerialPortConfiguration()
	console.attachment = VZFileHandleSerialPortAttachment(
		fileHandleForReading: channels.consoleIn.fileHandleForReading,
		fileHandleForWriting: channels.consoleOut.fileHandleForWriting)
	let agent = VZVirtioConsoleDeviceSerialPortConfiguration()
	agent.attachment = VZFileHandleSerialPortAttachment(
		fileHandleForReading: channels.agentIn.fileHandleForReading,
		fileHandleForWriting: channels.agentOut.fileHandleForWriting)
	config.serialPorts = [console, agent]
	config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

	if spec.nat {
		let network = VZVirtioNetworkDeviceConfiguration()
		network.attachment = VZNATNetworkDeviceAttachment()
		config.networkDevices = [network]
	}
	if let disk = spec.disk {
		let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: disk), readOnly: false)
		config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
	}
	var shares: [VZDirectorySharingDeviceConfiguration] = []
	for (index, mount) in spec.mounts.enumerated() {
		let device = VZVirtioFileSystemDeviceConfiguration(tag: "m\(index)")
		device.share = VZSingleDirectoryShare(
			directory: VZSharedDirectory(url: URL(fileURLWithPath: mount.path), readOnly: mount.readOnly))
		shares.append(device)
	}
	config.directorySharingDevices = shares
	try config.validate()
	return config
}

// MARK: - Line reading

/// Calls `onLine` on the main queue for every complete line the handle produces; `onEnd` at end of input.
final class LineReader {
	private var buffer = Data()
	private let handle: FileHandle
	private let onLine: (Data) -> Void
	private let onEnd: () -> Void

	init(_ handle: FileHandle, onLine: @escaping (Data) -> Void, onEnd: @escaping () -> Void = {}) {
		self.handle = handle
		self.onLine = onLine
		self.onEnd = onEnd
	}

	func start() {
		handle.readabilityHandler = { [self] file in
			let chunk = file.availableData
			if chunk.isEmpty {
				file.readabilityHandler = nil
				DispatchQueue.main.async { self.onEnd() }
				return
			}
			buffer.append(chunk)
			while let newline = buffer.firstIndex(of: 0x0a) {
				let line = Data(buffer[buffer.startIndex..<newline])
				buffer.removeSubrange(buffer.startIndex...newline)
				if !line.isEmpty { DispatchQueue.main.async { self.onLine(line) } }
			}
		}
	}
}

func parseObject(_ line: Data) -> [String: Any]? {
	(try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
}

// MARK: - Terminal socket

/// One terminal client: a connection on the terminal socket and the guest pty it drives.
final class TerminalClient {
	let fd: Int32
	var ptyId: Int?
	private let writeLock = NSLock()

	init(fd: Int32) { self.fd = fd }

	func send(_ object: [String: Any]) {
		guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
		data.append(0x0a)
		writeLock.lock()
		defer { writeLock.unlock() }
		var offset = 0
		while offset < data.count {
			let written = data.withUnsafeBytes { write(fd, $0.baseAddress! + offset, data.count - offset) }
			if written <= 0 { return }
			offset += written
		}
	}

	func close() { Darwin.close(fd) }
}

func unixAddress(_ path: String) -> sockaddr_un? {
	var address = sockaddr_un()
	address.sun_family = sa_family_t(AF_UNIX)
	let bytes = Array(path.utf8)
	guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
	withUnsafeMutableBytes(of: &address.sun_path) { buffer in
		for (index, byte) in bytes.enumerated() { buffer[index] = byte }
		buffer[bytes.count] = 0
	}
	return address
}

/// Reads lines from `fd` on the calling (background) thread; `onLine` runs on the main queue.
func readLines(_ fd: Int32, onLine: @escaping (Data) -> Void, onEnd: @escaping () -> Void) {
	var buffer = Data()
	var chunk = [UInt8](repeating: 0, count: 16384)
	while true {
		let count = read(fd, &chunk, chunk.count)
		if count <= 0 { break }
		buffer.append(chunk, count: count)
		while let newline = buffer.firstIndex(of: 0x0a) {
			let line = Data(buffer[buffer.startIndex..<newline])
			buffer.removeSubrange(buffer.startIndex...newline)
			if !line.isEmpty { DispatchQueue.main.async { onLine(line) } }
		}
	}
	DispatchQueue.main.async { onEnd() }
}

/// The terminal socket: accepts clients of this user and relays them to the guest's pty ops.
final class TerminalHub {
	private var path: String?
	private var clients: [Int: TerminalClient] = [:]  // guest ptyId -> client
	private var nextPty = 1
	private let toGuest: ([String: Any]) -> Void
	/// Whether the guest agent announced the `pty-*` ops; an image built before they existed did not.
	var guestHasPty = false

	init(toGuest: @escaping ([String: Any]) -> Void) { self.toGuest = toGuest }

	func listen(on path: String) {
		guard let address = unixAddress(path) else { log("terminal socket path too long: \(path)"); return }
		unlink(path)
		let server = socket(AF_UNIX, SOCK_STREAM, 0)
		guard server >= 0 else { return }
		var bound = address
		let bindResult = withUnsafePointer(to: &bound) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		guard bindResult == 0, chmod(path, 0o600) == 0, Darwin.listen(server, 4) == 0 else {
			log("terminal socket \(path): \(String(cString: strerror(errno)))")
			Darwin.close(server)
			return
		}
		self.path = path
		Thread.detachNewThread { [self] in
			while true {
				let client = accept(server, nil, nil)
				if client < 0 { return }
				var uid: uid_t = 0, gid: gid_t = 0
				guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { Darwin.close(client); continue }
				Thread.detachNewThread { [self] in serve(TerminalClient(fd: client)) }
			}
		}
	}

	private func serve(_ client: TerminalClient) {
		readLines(client.fd, onLine: { [self] line in handle(client, line) }, onEnd: { [self] in drop(client) })
	}

	private func handle(_ client: TerminalClient, _ line: Data) {
		guard let message = parseObject(line), let kind = message["t"] as? String else { return }
		switch kind {
		case "open":
			guard client.ptyId == nil else { return }
			guard guestHasPty else {
				let text = "\r\nThis VM image predates the terminal. Rebuild it with scripts/build-image.sh (alpine or ubuntu), then stop and start the VM.\r\n"
				client.send(["t": "out", "d": Data(text.utf8).base64EncodedString()])
				client.send(["t": "exit", "code": 1])
				client.close()
				return
			}
			let id = nextPty
			nextPty += 1
			client.ptyId = id
			clients[id] = client
			toGuest([
				"op": "pty-open", "ptyId": id, "cols": message["cols"] ?? 80, "rows": message["rows"] ?? 24,
				"cwd": message["cwd"] ?? "/", "term": message["term"] ?? "xterm-256color",
			])
		case "in":
			if let id = client.ptyId { toGuest(["op": "pty-input", "ptyId": id, "d": message["d"] ?? ""]) }
		case "resize":
			if let id = client.ptyId { toGuest(["op": "pty-resize", "ptyId": id, "cols": message["cols"] ?? 80, "rows": message["rows"] ?? 24]) }
		default: break
		}
	}

	private func drop(_ client: TerminalClient) {
		if let id = client.ptyId {
			clients[id] = nil
			toGuest(["op": "pty-close", "ptyId": id])
		}
		client.close()
	}

	/// A `pty` or `pty-exit` line from the guest agent.
	func fromGuest(_ object: [String: Any]) {
		guard let id = object["ptyId"] as? Int, let client = clients[id] else { return }
		if object["type"] as? String == "pty" {
			client.send(["t": "out", "d": object["d"] ?? ""])
		} else {
			clients[id] = nil
			client.ptyId = nil
			client.send(["t": "exit", "code": object["code"] ?? 0])
			client.close()
		}
	}

	func shutdown() {
		for client in clients.values { client.close() }
		clients.removeAll()
		if let path { unlink(path) }
	}
}

// MARK: - Attach mode (the terminal panel's client)

func runAttachMode(_ arguments: [String]) -> Never {
	guard let socketPath = arguments.first else {
		log("usage: npi-vm-helper attach <socket> [--cwd DIR]")
		exit(64)
	}
	var cwd = "/"
	if let index = arguments.firstIndex(of: "--cwd"), index + 1 < arguments.count { cwd = arguments[index + 1] }
	guard var address = unixAddress(socketPath) else { log("socket path too long"); exit(64) }
	let fd = socket(AF_UNIX, SOCK_STREAM, 0)
	let connected = withUnsafePointer(to: &address) {
		$0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
	}
	guard fd >= 0, connected == 0 else {
		log("cannot reach the VM terminal at \(socketPath): \(String(cString: strerror(errno)))")
		exit(69)
	}
	let client = TerminalClient(fd: fd)

	var original = termios()
	let interactive = tcgetattr(STDIN_FILENO, &original) == 0
	func restore() { if interactive { var saved = original; tcsetattr(STDIN_FILENO, TCSANOW, &saved) } }
	if interactive {
		var raw = original
		cfmakeraw(&raw)
		tcsetattr(STDIN_FILENO, TCSANOW, &raw)
	}
	func size() -> (Int, Int) {
		var window = winsize()
		if ioctl(STDOUT_FILENO, TIOCGWINSZ, &window) == 0, window.ws_col > 0 { return (Int(window.ws_col), Int(window.ws_row)) }
		return (80, 24)
	}
	let (cols, rows) = size()
	client.send(["t": "open", "cols": cols, "rows": rows, "cwd": cwd, "term": ProcessInfo.processInfo.environment["TERM"] ?? "xterm-256color"])

	signal(SIGWINCH, SIG_IGN)
	let winch = DispatchSource.makeSignalSource(signal: SIGWINCH, queue: .main)
	winch.setEventHandler {
		let (cols, rows) = size()
		client.send(["t": "resize", "cols": cols, "rows": rows])
	}
	winch.resume()

	FileHandle.standardInput.readabilityHandler = { file in
		let chunk = file.availableData
		if chunk.isEmpty { file.readabilityHandler = nil; client.close(); return }
		client.send(["t": "in", "d": chunk.base64EncodedString()])
	}
	Thread.detachNewThread {
		readLines(fd, onLine: { line in
			guard let message = parseObject(line) else { return }
			if message["t"] as? String == "out", let text = message["d"] as? String, let data = Data(base64Encoded: text) {
				FileHandle.standardOutput.write(data)
			} else if message["t"] as? String == "exit" {
				restore()
				exit(Int32(truncatingIfNeeded: message["code"] as? Int ?? 0))
			}
		}, onEnd: {
			restore()
			exit(1)
		})
	}
	withExtendedLifetime(winch) { dispatchMain() }
}

// MARK: - Protocol mode

final class Helper: NSObject, VZVirtualMachineDelegate {
	var vm: VZVirtualMachine?
	var channels: Channels?
	var state = "stopped"
	var consoleTail = Data()
	var mounts: [Mount] = []
	var startId: Int?
	var stopId: Int?
	var pendingMounts = 0
	var agentReady = false
	var readers: [LineReader] = []
	var terminalSocket: String?
	lazy var terminals = TerminalHub(toGuest: { [unowned self] in self.sendToGuest($0) })

	func setState(_ next: String, detail: String? = nil) {
		state = next
		var message: [String: Any] = ["type": "state", "state": next]
		if let detail { message["detail"] = detail }
		emit(message)
	}

	func fail(_ id: Int?, _ message: String) {
		let detail = String(data: consoleTail.suffix(1500), encoding: .utf8) ?? ""
		let full = detail.isEmpty ? message : "\(message)\n--- guest console ---\n\(detail)"
		if let id { emit(["id": id, "type": "error", "message": full]) }
		setState("error", detail: message)
		startId = nil
	}

	func handle(_ request: [String: Any]) {
		guard let op = request["op"] as? String, let id = request["id"] as? Int else { return }
		switch op {
		case "start": start(id, request["config"] as? [String: Any] ?? [:])
		case "status": emit(["id": id, "type": "result", "state": state])
		case "stop": stop(id)
		case "exec", "cancel", "release":
			if state == "running" { sendToGuest(request) } else { emit(["id": id, "type": "error", "message": "the VM is \(state)"]) }
		default: emit(["id": id, "type": "error", "message": "unknown op \(op)"])
		}
	}

	func sendToGuest(_ object: [String: Any]) {
		guard let channels, let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
		channels.agentIn.fileHandleForWriting.write(data)
		channels.agentIn.fileHandleForWriting.write(Data([0x0a]))
	}

	func start(_ id: Int, _ raw: [String: Any]) {
		if vm != nil && state == "running" {
			emit(["id": id, "type": "result", "state": "running"])
			return
		}
		guard vm == nil else { emit(["id": id, "type": "error", "message": "the VM is \(state)"]); return }
		let imageDir = (raw["image"] as? String) ?? ""
		let kernel = imageDir + "/Image"
		let initrd = imageDir + "/rootfs.cpio.gz"
		let fm = FileManager.default
		guard !imageDir.isEmpty, fm.fileExists(atPath: kernel), fm.fileExists(atPath: initrd) else {
			emit(["id": id, "type": "error", "message": "VM image not found in \"\(imageDir)\"; build it with scripts/build-image.sh"])
			return
		}
		mounts = ((raw["mounts"] as? [[String: Any]]) ?? []).compactMap { entry in
			guard let path = entry["path"] as? String else { return nil }
			return Mount(path: path, readOnly: (entry["readOnly"] as? Bool) ?? false)
		}
		for mount in mounts {
			var isDirectory: ObjCBool = false
			guard fm.fileExists(atPath: mount.path, isDirectory: &isDirectory), isDirectory.boolValue else {
				emit(["id": id, "type": "error", "message": "mount folder does not exist: \(mount.path)"])
				return
			}
		}
		let nat = (raw["network"] as? String) == "nat"
		terminalSocket = raw["terminalSocket"] as? String
		let spec = GuestSpec(
			kernel: kernel, initrd: initrd,
			cmdline: "console=hvc0 rdinit=/sbin/npi-init quiet loglevel=3 npi.net=\(nat ? "nat" : "off")",
			memoryMiB: (raw["memoryMiB"] as? Int) ?? 2048, cpus: (raw["cpus"] as? Int) ?? 2,
			nat: nat, mounts: mounts, disk: nil)
		let channels = Channels()
		do {
			let config = try makeConfiguration(spec, channels: channels)
			let machine = VZVirtualMachine(configuration: config)
			machine.delegate = self
			self.vm = machine
			self.channels = channels
		} catch {
			emit(["id": id, "type": "error", "message": "could not configure the VM: \(error)"])
			setState("error", detail: "\(error)")
			return
		}
		startId = id
		setState("starting")
		readers = [
			LineReader(channels.agentOut.fileHandleForReading, onLine: { [self] line in fromGuest(line) }),
		]
		readers.forEach { $0.start() }
		channels.consoleOut.fileHandleForReading.readabilityHandler = { [self] file in
			let chunk = file.availableData
			if chunk.isEmpty { file.readabilityHandler = nil; return }
			DispatchQueue.main.async { [self] in
				log(String(decoding: chunk, as: UTF8.self))
				consoleTail.append(chunk)
				if consoleTail.count > 8192 { consoleTail = consoleTail.suffix(4096) }
			}
		}
		vm?.start { [self] result in
			if case .failure(let error) = result { fail(startId, "the VM did not start: \(error)") }
		}
		DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [self] in
			if startId != nil && !agentReady { fail(startId, "the guest did not come up within 90 seconds") }
		}
	}

	/// A line from the guest agent: the hello that marks it ready, an answer to a mount, or an answer for the plugin.
	func fromGuest(_ line: Data) {
		guard let object = parseObject(line) else { return }
		if object["type"] as? String == "state" {
			guard !agentReady else { return }
			agentReady = true
			terminals.guestHasPty = (object["pty"] as? Bool) ?? false
			pendingMounts = mounts.count
			if mounts.isEmpty { becomeRunning() }
			for (index, mount) in mounts.enumerated() {
				sendToGuest(["id": -(index + 1), "op": "mount", "tag": "m\(index)", "path": mount.path, "readOnly": mount.readOnly])
			}
			return
		}
		if let kind = object["type"] as? String, kind == "pty" || kind == "pty-exit" {
			terminals.fromGuest(object)
			return
		}
		if let id = object["id"] as? Int, id < 0 {
			if id == -100 { return }
			if (object["type"] as? String) == "error" {
				fail(startId, "mounting \(mounts[-id - 1].path) in the guest failed: \(object["message"] as? String ?? "")")
				return
			}
			pendingMounts -= 1
			if pendingMounts == 0 { becomeRunning() }
			return
		}
		outputLock.lock()
		FileHandle.standardOutput.write(line)
		FileHandle.standardOutput.write(Data([0x0a]))
		outputLock.unlock()
	}

	func becomeRunning() {
		guard let id = startId else { return }
		startId = nil
		state = "running"
		emit(["id": id, "type": "result", "state": "running"])
		emit(["type": "state", "state": "running"])
		if let path = terminalSocket { terminals.listen(on: path) }
	}

	func stop(_ id: Int) {
		guard let machine = vm, state != "stopped" else {
			emit(["id": id, "type": "result", "state": "stopped"])
			exit(0)
		}
		stopId = id
		terminals.shutdown()
		sendToGuest(["id": -100, "op": "poweroff"])
		DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
			if machine.state != .stopped { machine.stop { _ in } }
		}
	}

	func guestDidStop(_ virtualMachine: VZVirtualMachine) {
		if let id = stopId {
			emit(["id": id, "type": "result", "state": "stopped"])
			exit(0)
		}
		terminals.shutdown()
		setState("stopped", detail: "the guest stopped")
		exit(1)
	}

	func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
		terminals.shutdown()
		setState("error", detail: "\(error)")
		exit(1)
	}
}

func runProtocolMode() -> Never {
	let helper = Helper()
	let input = LineReader(FileHandle.standardInput, onLine: { line in
		if let object = parseObject(line) { helper.handle(object) }
	}, onEnd: {
		// The plugin went away: take the machine down with it.
		exit(0)
	})
	input.start()
	helper.readers.append(input)
	dispatchMain()
}

// MARK: - Run mode (image building)

final class Runner: NSObject, VZVirtualMachineDelegate {
	func guestDidStop(_ virtualMachine: VZVirtualMachine) { exit(0) }
	func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
		log("guest stopped with error: \(error)")
		exit(1)
	}
}

func runConsoleMode(_ arguments: [String]) -> Never {
	var spec = GuestSpec(kernel: "", initrd: "", cmdline: "console=hvc0", memoryMiB: 3072, cpus: 2, nat: false, mounts: [], disk: nil)
	var index = 0
	func value() -> String {
		index += 1
		guard index < arguments.count else {
			log("missing value for \(arguments[index - 1])")
			exit(64)
		}
		return arguments[index]
	}
	while index < arguments.count {
		switch arguments[index] {
		case "--kernel": spec.kernel = value()
		case "--initrd": spec.initrd = value()
		case "--cmdline": spec.cmdline = value()
		case "--mem": spec.memoryMiB = Int(value()) ?? 3072
		case "--cpus": spec.cpus = Int(value()) ?? 2
		case "--net": spec.nat = value() == "nat"
		case "--disk": spec.disk = value()
		case "--share": spec.mounts.append(Mount(path: value(), readOnly: false))
		default:
			log("unknown option \(arguments[index])")
			exit(64)
		}
		index += 1
	}
	guard !spec.kernel.isEmpty, !spec.initrd.isEmpty else {
		log("usage: npi-vm-helper run --kernel K --initrd I [--cmdline S] [--mem MiB] [--cpus N] [--net nat] [--share DIR] [--disk IMG]")
		exit(64)
	}
	let channels = Channels()
	let runner = Runner()
	do {
		let config = try makeConfiguration(spec, channels: channels)
		let machine = VZVirtualMachine(configuration: config)
		machine.delegate = runner
		channels.consoleOut.fileHandleForReading.readabilityHandler = { file in
			let chunk = file.availableData
			if chunk.isEmpty { file.readabilityHandler = nil; return }
			FileHandle.standardOutput.write(chunk)
		}
		FileHandle.standardInput.readabilityHandler = { file in
			let chunk = file.availableData
			if chunk.isEmpty { file.readabilityHandler = nil; return }
			channels.consoleIn.fileHandleForWriting.write(chunk)
		}
		machine.start { result in
			if case .failure(let error) = result {
				log("the VM did not start: \(error)")
				exit(3)
			}
		}
		withExtendedLifetime((runner, channels, machine)) { dispatchMain() }
	} catch {
		log("could not configure the VM: \(error)")
		exit(2)
	}
}

// MARK: - Entry

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "run" {
	runConsoleMode(Array(arguments.dropFirst()))
} else if arguments.first == "attach" {
	runAttachMode(Array(arguments.dropFirst()))
} else {
	runProtocolMode()
}
