import AppKit

// Finder sends reopen events to an existing application instead of starting
// another executable. Keep that event loop separate from the local web server.
@MainActor
final class EditorApplication: NSObject, NSApplicationDelegate {
    private var backend: Process?
    private var opening: Process?
    private var output: Pipe?
    private var pendingOutput = Data()
    private var connection: (url: URL, token: String)?
    private var updater: ApplicationUpdater?
    private var terminationPending = false
    private let nativeUpdateToken = UUID().uuidString + UUID().uuidString
    private static let resumeKey = "LocalTeXWebEditorUpdateRelaunch"
    private let arguments = EditorApplication.launchArguments()

    private static func launchArguments() -> [String] {
        let supplied = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
        let defaults = UserDefaults.standard
        let saved = defaults.dictionary(forKey: resumeKey)
        defaults.removeObject(forKey: resumeKey)
        guard supplied.isEmpty, let saved,
              saved["application"] as? String == Bundle.main.bundleURL.path,
              let date = saved["createdAt"] as? Double,
              Date().timeIntervalSince1970 - date >= 0,
              Date().timeIntervalSince1970 - date < 300,
              let arguments = saved["arguments"] as? [String] else { return supplied }
        return arguments
    }

    private func rememberUpdateRelaunch() {
        var nextArguments = arguments
        if !nextArguments.contains("--background") { nextArguments.append("--background") }
        UserDefaults.standard.set([
            "application": Bundle.main.bundleURL.path,
            "createdAt": Date().timeIntervalSince1970,
            "arguments": nextArguments,
        ], forKey: Self.resumeKey)
        UserDefaults.standard.synchronize()
    }

    private func command() -> Process {
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/local-tex-web-editor")
        process.arguments = arguments
        return process
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let process = command()
        var environment = ProcessInfo.processInfo.environment
        environment["LOCAL_TEX_EDITOR_NATIVE_UPDATE_TOKEN"] = nativeUpdateToken
        process.environment = environment
        let pipe = Pipe()
        output = pipe
        process.standardOutput = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            FileHandle.standardOutput.write(data)
            DispatchQueue.main.async { self?.receiveOutput(data) }
        }
        process.terminationHandler = { _ in
            DispatchQueue.main.async {
                self.updater?.stop()
                if self.terminationPending { NSApplication.shared.reply(toApplicationShouldTerminate: true) }
                else { NSApplication.shared.terminate(nil) }
            }
        }
        do {
            try process.run()
            backend = process
        } catch {
            let alert = NSAlert()
            alert.messageText = Locale.preferredLanguages.first?.hasPrefix("ja") == true ? "Local TeX Web Editor を起動できません" : "Could not start Local TeX Web Editor"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .critical
            alert.runModal()
            NSApplication.shared.terminate(nil)
        }
    }

    private func receiveOutput(_ data: Data) {
        guard connection == nil else { return }
        pendingOutput.append(data)
        while let newline = pendingOutput.firstIndex(of: 10) {
            let line = pendingOutput[..<newline]
            pendingOutput.removeSubrange(...newline)
            guard let info = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  info["phase"] as? String != "update",
                  let address = info["url"] as? String, let url = URL(string: address),
                  url.scheme == "http", ["127.0.0.1", "::1", "[::1]"].contains(url.host ?? ""),
                  let token = info["token"] as? String, token.count >= 16 else { continue }
            connection = (url, token)
            let updates = ApplicationUpdater(url: url, token: token, nativeToken: nativeUpdateToken)
            updater = updates
            // Let the browser finish its initial work before contacting Sparkle.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak updates] in updates?.start() }
            break
        }
        if pendingOutput.count > 1_048_576 { pendingOutput.removeAll() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard backend?.isRunning == true else { return .terminateNow }
        if updater?.deferUnapprovedTermination() == true { return .terminateCancel }
        guard updater?.installationApproved == true, let connection else {
            // A user-requested ordinary quit closes the backend as well. An
            // update reaches this point only after the editor approves it.
            backend?.terminate()
            return .terminateNow
        }
        if terminationPending { return .terminateLater }
        terminationPending = true
        rememberUpdateRelaunch()
        var request = URLRequest(url: connection.url.appendingPathComponent("api/shutdown"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue(connection.token, forHTTPHeaderField: "X-Local-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self, self.terminationPending else { return }
                if self.backend?.isRunning != true {
                    sender.reply(toApplicationShouldTerminate: true)
                } else if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
                    self.terminationPending = false
                    UserDefaults.standard.removeObject(forKey: Self.resumeKey)
                    self.updater?.shutdownFailed()
                    sender.reply(toApplicationShouldTerminate: false)
                }
            }
        }.resume()
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard backend?.isRunning == true, opening?.isRunning != true else { return false }
        // The server's existing instance handling opens another editor tab.
        let process = command()
        do {
            try process.run()
            opening = process
        } catch {
            NSLog("Could not reopen Local TeX Web Editor: %@", error.localizedDescription)
        }
        return false
    }
}

@main
struct EditorLauncher {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = EditorApplication()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}
