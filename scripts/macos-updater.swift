import AppKit
import Sparkle

// The editor owns the settings and decides when every browser tab is ready.
// Sparkle owns downloading, verifying, replacing, and relaunching the bundle.
@MainActor
final class ApplicationUpdater: NSObject, SPUUpdaterDelegate {
    private let endpoint: URL
    private let token: String
    private let nativeToken: String
    private let session: URLSession
    private var controller: SPUStandardUpdaterController!
    private var timer: Timer?
    private var polling = false
    private var posting = false
    private var started = false
    private var statusRevision = 0
    private var postedRevision = -1
    private var lastCommandID = ""
    private var installHandler: (() -> Void)?
    private var installerStarted = false
    private var status: [String: Any] = ["phase": "up-to-date", "progress": 0]
    private(set) var installationApproved = false

    init(url: URL, token: String, nativeToken: String) {
        endpoint = url.appendingPathComponent("api/updates/native")
        self.token = token
        self.nativeToken = nativeToken
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        session = URLSession(configuration: configuration)
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    }

    func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.poll() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        session.invalidateAndCancel()
    }

    private func request(method: String = "GET") -> URLRequest {
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(token, forHTTPHeaderField: "X-Local-Token")
        request.setValue(nativeToken, forHTTPHeaderField: "X-Native-Update-Token")
        return request
    }

    private func poll() {
        guard !polling else { return }
        polling = true
        session.dataTask(with: request()) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.polling = false
                guard error == nil, let response = response as? HTTPURLResponse,
                      response.statusCode == 200, let data, data.count < 65536,
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                self.configure(value)
                self.postStatus()
            }
        }.resume()
    }

    private func configure(_ value: [String: Any]) {
        let automatic = value["automatic"] as? Bool ?? true
        let updater = controller.updater
        // The backend supplies the saved choice before Sparkle schedules checks.
        // Info.plist supplies the initial defaults for a new installation.
        if updater.automaticallyChecksForUpdates != automatic {
            updater.automaticallyChecksForUpdates = automatic
        }
        if updater.automaticallyDownloadsUpdates != automatic {
            updater.automaticallyDownloadsUpdates = automatic
        }
        if !started {
            do {
                try updater.start()
                started = true
                if let lastCheck = updater.lastUpdateCheckDate {
                    status["checkedAt"] = ISO8601DateFormatter().string(from: lastCheck)
                }
                statusRevision += 1
            } catch {
                setError(error)
                return
            }
        }
        guard let command = value["command"] as? [String: Any],
              let id = command["id"] as? String, !id.isEmpty, id != lastCommandID,
              let action = command["action"] as? String else { return }
        lastCommandID = id
        status["completedCommandId"] = id
        statusRevision += 1
        switch action {
        case "check":
            if installHandler != nil && !installationApproved {
                setPhase("ready")
            } else if updater.canCheckForUpdates {
                setPhase("checking")
                if automatic { updater.checkForUpdatesInBackground() }
                else { controller.checkForUpdates(nil) }
            }
        case "install":
            guard let install = installHandler else {
                setError(NSError(domain: "LocalTeXWebEditor", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "The update is not ready to install. Check for updates again."]))
                return
            }
            installationApproved = true
            installHandler = { NSApplication.shared.terminate(nil) }
            setPhase("applying")
            install()
        default:
            break
        }
    }

    private func setPhase(_ phase: String, item: SUAppcastItem? = nil) {
        status["phase"] = phase
        status["error"] = ""
        if let item {
            status["latestVersion"] = item.displayVersionString
            status["releaseNotesURL"] = "https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/tag/v\(item.displayVersionString)"
        }
        if phase == "checking" { status["progress"] = 0 }
        if phase == "ready" { status["progress"] = 1 }
        statusRevision += 1
        postStatus()
    }

    private func setError(_ error: Error) {
        installationApproved = false
        installerStarted = false
        installHandler = nil
        status["phase"] = "error"
        status["error"] = error.localizedDescription
        status["checkedAt"] = ISO8601DateFormatter().string(from: Date())
        statusRevision += 1
        postStatus()
    }

    private func postStatus() {
        guard !posting, statusRevision != postedRevision else { return }
        var request = request(method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let body = try? JSONSerialization.data(withJSONObject: status) else { return }
        request.httpBody = body
        let revision = statusRevision
        posting = true
        session.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.posting = false
                if error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200 {
                    self.postedRevision = revision
                    if self.statusRevision != revision { self.postStatus() }
                }
            }
        }.resume()
    }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        setPhase("checking")
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        setPhase("downloading", item: item)
    }

    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        setPhase("downloading", item: item)
    }

    func updater(_ updater: SPUUpdater, willExtractUpdate item: SUAppcastItem) {
        setPhase("downloading", item: item)
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        installerStarted = true
    }

    func updater(_ updater: SPUUpdater, shouldDownloadReleaseNotesForUpdate updateItem: SUAppcastItem) -> Bool {
        // The browser opens the release's own page from its update controls.
        return false
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        status["checkedAt"] = ISO8601DateFormatter().string(from: Date())
        status["latestVersion"] = ""
        setPhase("up-to-date")
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        installHandler = immediateInstallHandler
        status["checkedAt"] = ISO8601DateFormatter().string(from: Date())
        setPhase("ready", item: item)
        return true
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        if installationApproved { return false }
        self.installHandler = installHandler
        status["checkedAt"] = ISO8601DateFormatter().string(from: Date())
        setPhase("ready", item: item)
        return true
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        // Sparkle also reports the no-update result as an error after the
        // updaterDidNotFindUpdate callback has already published its result.
        if (error as NSError).domain == SUSparkleErrorDomain && (error as NSError).code == Int(SUError.noUpdateError.rawValue) { return }
        setError(error)
    }

    func shutdownFailed() {
        setError(NSError(domain: "LocalTeXWebEditor", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "The editor could not finish saving and close for the update. Try again from the editor."]))
        // Sparkle's installer is already waiting for this application to exit.
        // A later command can retry after the editor has prepared its tabs.
        installerStarted = true
        installHandler = { NSApplication.shared.terminate(nil) }
    }

    func deferUnapprovedTermination() -> Bool {
        guard installerStarted, !installationApproved else { return false }
        // A resumed Sparkle installer can send a quit event without consulting
        // shouldPostponeRelaunchForUpdate again. The editor must still prepare
        // every tab before this process accepts that event.
        if installHandler == nil {
            installHandler = { NSApplication.shared.terminate(nil) }
        }
        setPhase("ready")
        return true
    }
}
