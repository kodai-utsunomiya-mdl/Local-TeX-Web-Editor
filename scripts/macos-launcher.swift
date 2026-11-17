import AppKit

// Finder sends reopen events to an existing application instead of starting
// another executable. Keep that event loop separate from the local web server.
final class EditorApplication: NSObject, NSApplicationDelegate {
    private var backend: Process?
    private var opening: Process?
    private let arguments = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }

    private func command() -> Process {
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/local-tex-web-editor")
        process.arguments = arguments
        return process
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let process = command()
        process.terminationHandler = { _ in
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
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

let application = NSApplication.shared
let delegate = EditorApplication()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
