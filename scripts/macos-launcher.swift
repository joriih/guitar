import AppKit
import Darwin
import Foundation

private enum LauncherConstants {
  static let appName = "Riff Sketchbook"
  static let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Riff Sketchbook", isDirectory: true)
  static let installedRuntime = supportDirectory
    .appendingPathComponent("runtime", isDirectory: true)
  static let logDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Riff Sketchbook", isDirectory: true)
  static let logFile = logDirectory.appendingPathComponent("launcher.log")
  static let appPort = 43_117
  static let appURL = URL(string: "http://127.0.0.1:\(appPort)")!
  static let healthURL = appURL.appendingPathComponent("api/auth/status")
  static let startupTimeout: TimeInterval = 35
}

private enum LauncherError: LocalizedError {
  case missingRuntime
  case cannotCreateLog
  case serverExited(Int32)
  case startupTimedOut

  var errorDescription: String? {
    switch self {
    case .missingRuntime:
      return "설치된 실행 파일을 찾지 못했어요."
    case .cannotCreateLog:
      return "실행 기록을 안전하게 만들지 못했어요."
    case let .serverExited(status):
      return "서버가 예상보다 일찍 종료됐어요. (코드 \(status))"
    case .startupTimedOut:
      return "서버 준비가 평소보다 오래 걸리고 있어요."
    }
  }
}

private struct RuntimeLocation {
  let directory: URL
  let node: URL
  let entryPoint: URL

  static func locate() throws -> RuntimeLocation {
    var candidates: [URL] = []
    if let resources = Bundle.main.resourceURL {
      candidates.append(resources.appendingPathComponent("runtime", isDirectory: true))
    }
    candidates.append(LauncherConstants.installedRuntime)

    for directory in candidates {
      let node = directory.appendingPathComponent(".runtime-node/bin/node")
      let entryPoint = directory.appendingPathComponent("scripts/start-app.mjs")
      if FileManager.default.isExecutableFile(atPath: node.path),
         FileManager.default.isReadableFile(atPath: entryPoint.path)
      {
        return RuntimeLocation(directory: directory, node: node, entryPoint: entryPoint)
      }
    }
    throw LauncherError.missingRuntime
  }
}

private final class LauncherLogger {
  let fileURL = LauncherConstants.logFile
  private let lock = NSLock()
  private var handle: FileHandle?

  init() throws {
    let manager = FileManager.default
    try manager.createDirectory(
      at: LauncherConstants.logDirectory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: NSNumber(value: 0o700)]
    )
    try manager.setAttributes(
      [.posixPermissions: NSNumber(value: 0o700)],
      ofItemAtPath: LauncherConstants.logDirectory.path
    )

    if !manager.fileExists(atPath: fileURL.path) {
      guard manager.createFile(
        atPath: fileURL.path,
        contents: nil,
        attributes: [.posixPermissions: NSNumber(value: 0o600)]
      ) else {
        throw LauncherError.cannotCreateLog
      }
    }
    try manager.setAttributes(
      [.posixPermissions: NSNumber(value: 0o600)],
      ofItemAtPath: fileURL.path
    )
    handle = try FileHandle(forWritingTo: fileURL)
    try handle?.seekToEnd()
    write("실행 창을 열었어요.")
  }

  func childOutputHandle() -> FileHandle? {
    handle
  }

  func write(_ message: String) {
    let formatter = ISO8601DateFormatter()
    let line = "[\(formatter.string(from: Date()))] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    lock.lock()
    defer { lock.unlock() }
    try? handle?.write(contentsOf: data)
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    try? handle?.synchronize()
    try? handle?.close()
    handle = nil
  }
}

private final class CardView: NSView {
  init(color: NSColor, radius: CGFloat, borderColor: NSColor? = nil) {
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = color.cgColor
    layer?.cornerRadius = radius
    layer?.cornerCurve = .continuous
    if let borderColor {
      layer?.borderWidth = 1
      layer?.borderColor = borderColor.cgColor
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}

private final class LauncherWindowController: NSWindowController {
  enum State {
    case checking
    case starting
    case readyOwned
    case readyExisting
    case stopping
    case shutdownDelayed
    case stopped
    case failed(String)
  }

  private let statusHeadline = NSTextField(labelWithString: "앱 상태를 확인하고 있어요")
  private let statusDetail = NSTextField(labelWithString: "잠시만 기다려 주세요.")
  private let statusDot = CardView(color: .systemOrange, radius: 5)
  private let spinner = NSProgressIndicator()
  private let openButton = NSButton(title: "웹 화면 열기", target: nil, action: nil)
  private let serverButton = NSButton(title: "시작 취소", target: nil, action: nil)
  private let logButton = NSButton(title: "실행 기록 보기", target: nil, action: nil)
  private let coordinator: LauncherCoordinator

  init(coordinator: LauncherCoordinator) {
    self.coordinator = coordinator
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 520, height: 408),
      styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = LauncherConstants.appName
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: .aqua)
    window.backgroundColor = .white
    window.center()
    window.setFrameAutosaveName("RiffSketchbookLauncherWindow")
    super.init(window: window)
    buildInterface(in: window)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  private func label(
    _ text: String,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = .labelColor
  ) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    return field
  }

  private func buildInterface(in window: NSWindow) {
    guard let content = window.contentView else { return }
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor.white.cgColor

    let iconCard = CardView(
      color: NSColor(calibratedWhite: 0.955, alpha: 1),
      radius: 15
    )
    iconCard.translatesAutoresizingMaskIntoConstraints = false
    let icon = NSImageView()
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "리프 파형")
    icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 23, weight: .medium)
    icon.contentTintColor = NSColor(calibratedWhite: 0.12, alpha: 1)
    iconCard.addSubview(icon)

    let title = label("Riff Sketchbook", size: 22, weight: .semibold)
    let subtitle = label(
      "떠오른 기타 아이디어를 이 Mac에 조용히 모아두세요.",
      size: 13,
      color: .secondaryLabelColor
    )
    let titleStack = NSStackView(views: [title, subtitle])
    titleStack.orientation = .vertical
    titleStack.alignment = .leading
    titleStack.spacing = 5

    let localBadge = label(
      "이 Mac에서만",
      size: 11,
      weight: .medium,
      color: NSColor(calibratedWhite: 0.33, alpha: 1)
    )
    let badgeCard = CardView(
      color: NSColor(calibratedWhite: 0.965, alpha: 1),
      radius: 10
    )
    badgeCard.translatesAutoresizingMaskIntoConstraints = false
    localBadge.translatesAutoresizingMaskIntoConstraints = false
    badgeCard.addSubview(localBadge)

    let header = NSStackView(views: [iconCard, titleStack, badgeCard])
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 14
    header.translatesAutoresizingMaskIntoConstraints = false
    titleStack.setHuggingPriority(.defaultLow, for: .horizontal)
    titleStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let statusCard = CardView(
      color: NSColor(calibratedWhite: 0.975, alpha: 1),
      radius: 16,
      borderColor: NSColor(calibratedWhite: 0.91, alpha: 1)
    )
    statusCard.translatesAutoresizingMaskIntoConstraints = false

    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.startAnimation(nil)
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusDot.isHidden = true
    let indicatorHost = NSView()
    indicatorHost.translatesAutoresizingMaskIntoConstraints = false
    indicatorHost.addSubview(spinner)
    indicatorHost.addSubview(statusDot)

    statusHeadline.font = .systemFont(ofSize: 15, weight: .semibold)
    statusDetail.font = .systemFont(ofSize: 12.5, weight: .regular)
    statusDetail.textColor = .secondaryLabelColor
    statusDetail.maximumNumberOfLines = 2
    statusDetail.lineBreakMode = .byWordWrapping
    let statusText = NSStackView(views: [statusHeadline, statusDetail])
    statusText.orientation = .vertical
    statusText.alignment = .leading
    statusText.spacing = 5
    statusText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    let statusRow = NSStackView(views: [indicatorHost, statusText])
    statusRow.orientation = .horizontal
    statusRow.alignment = .centerY
    statusRow.spacing = 13
    statusRow.translatesAutoresizingMaskIntoConstraints = false
    statusCard.addSubview(statusRow)

    configurePrimaryButton(openButton, action: #selector(openWebApp))
    configureSecondaryButton(serverButton, action: #selector(toggleServer))
    let actions = NSStackView(views: [openButton, serverButton])
    actions.orientation = .horizontal
    actions.alignment = .centerY
    actions.distribution = .fillEqually
    actions.spacing = 10
    actions.translatesAutoresizingMaskIntoConstraints = false

    logButton.target = self
    logButton.action = #selector(showLog)
    logButton.isBordered = false
    logButton.font = .systemFont(ofSize: 12, weight: .medium)
    logButton.contentTintColor = .secondaryLabelColor
    logButton.toolTip = "문제가 생겼을 때 확인할 수 있는 비공개 기록이에요."

    let footerText = label(
      "이 창을 닫으면 로컬 서버도 안전하게 종료돼요.",
      size: 11.5,
      color: .tertiaryLabelColor
    )
    let footer = NSStackView(views: [footerText, NSView(), logButton])
    footer.orientation = .horizontal
    footer.alignment = .centerY
    footer.spacing = 8
    footer.translatesAutoresizingMaskIntoConstraints = false

    content.addSubview(header)
    content.addSubview(statusCard)
    content.addSubview(actions)
    content.addSubview(footer)

    NSLayoutConstraint.activate([
      iconCard.widthAnchor.constraint(equalToConstant: 52),
      iconCard.heightAnchor.constraint(equalToConstant: 52),
      icon.centerXAnchor.constraint(equalTo: iconCard.centerXAnchor),
      icon.centerYAnchor.constraint(equalTo: iconCard.centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 28),
      icon.heightAnchor.constraint(equalToConstant: 28),

      localBadge.leadingAnchor.constraint(equalTo: badgeCard.leadingAnchor, constant: 10),
      localBadge.trailingAnchor.constraint(equalTo: badgeCard.trailingAnchor, constant: -10),
      localBadge.topAnchor.constraint(equalTo: badgeCard.topAnchor, constant: 6),
      localBadge.bottomAnchor.constraint(equalTo: badgeCard.bottomAnchor, constant: -6),

      header.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
      header.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
      header.topAnchor.constraint(equalTo: content.topAnchor, constant: 52),

      statusCard.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
      statusCard.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
      statusCard.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 28),
      statusCard.heightAnchor.constraint(equalToConstant: 105),

      statusRow.leadingAnchor.constraint(equalTo: statusCard.leadingAnchor, constant: 20),
      statusRow.trailingAnchor.constraint(equalTo: statusCard.trailingAnchor, constant: -20),
      statusRow.centerYAnchor.constraint(equalTo: statusCard.centerYAnchor),
      indicatorHost.widthAnchor.constraint(equalToConstant: 24),
      indicatorHost.heightAnchor.constraint(equalToConstant: 24),
      spinner.centerXAnchor.constraint(equalTo: indicatorHost.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: indicatorHost.centerYAnchor),
      statusDot.widthAnchor.constraint(equalToConstant: 10),
      statusDot.heightAnchor.constraint(equalToConstant: 10),
      statusDot.centerXAnchor.constraint(equalTo: indicatorHost.centerXAnchor),
      statusDot.centerYAnchor.constraint(equalTo: indicatorHost.centerYAnchor),

      actions.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
      actions.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
      actions.topAnchor.constraint(equalTo: statusCard.bottomAnchor, constant: 18),
      openButton.heightAnchor.constraint(equalToConstant: 42),
      serverButton.heightAnchor.constraint(equalToConstant: 42),

      footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
      footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      footer.topAnchor.constraint(equalTo: actions.bottomAnchor, constant: 19),
    ])
  }

  private func configurePrimaryButton(_ button: NSButton, action: Selector) {
    button.target = self
    button.action = action
    button.bezelStyle = .rounded
    button.controlSize = .large
    button.font = .systemFont(ofSize: 13.5, weight: .semibold)
    button.bezelColor = NSColor(calibratedWhite: 0.12, alpha: 1)
    button.contentTintColor = .white
    button.keyEquivalent = "\r"
    button.toolTip = "Riff Sketchbook 웹 화면을 열어요."
  }

  private func configureSecondaryButton(_ button: NSButton, action: Selector) {
    button.target = self
    button.action = action
    button.bezelStyle = .rounded
    button.controlSize = .large
    button.font = .systemFont(ofSize: 13.5, weight: .medium)
    button.contentTintColor = .labelColor
  }

  func render(_ state: State) {
    let showsProgress: Bool
    let dotColor: NSColor

    switch state {
    case .checking:
      statusHeadline.stringValue = "앱 상태를 확인하고 있어요"
      statusDetail.stringValue = "이미 실행 중인 창이 있는지 살펴보는 중이에요."
      showsProgress = true
      dotColor = .systemOrange
      openButton.isEnabled = false
      serverButton.title = "시작 취소"
      serverButton.isEnabled = true
    case .starting:
      statusHeadline.stringValue = "스케치북을 준비하고 있어요"
      statusDetail.stringValue = "보통 몇 초 안에 웹 화면이 자동으로 열려요."
      showsProgress = true
      dotColor = .systemOrange
      openButton.isEnabled = false
      serverButton.title = "시작 취소"
      serverButton.isEnabled = true
    case .readyOwned:
      statusHeadline.stringValue = "준비됐어요"
      statusDetail.stringValue = "이 Mac 안에서만 실행 중이에요. 바로 기록을 시작해 보세요."
      showsProgress = false
      dotColor = .systemGreen
      openButton.isEnabled = true
      serverButton.title = "서버 종료"
      serverButton.isEnabled = true
    case .readyExisting:
      statusHeadline.stringValue = "이미 실행 중인 스케치북에 연결했어요"
      statusDetail.stringValue = "기존 서버는 그대로 두고 웹 화면만 열었어요."
      showsProgress = false
      dotColor = .systemGreen
      openButton.isEnabled = true
      serverButton.title = "다른 창에서 실행 중"
      serverButton.isEnabled = false
    case .stopping:
      statusHeadline.stringValue = "안전하게 종료하고 있어요"
      statusDetail.stringValue = "서버 연결을 정리하는 동안 잠시만 기다려 주세요."
      showsProgress = true
      dotColor = .systemOrange
      openButton.isEnabled = false
      serverButton.title = "종료 중"
      serverButton.isEnabled = false
    case .shutdownDelayed:
      statusHeadline.stringValue = "서버 종료가 지연되고 있어요"
      statusDetail.stringValue = "강제로 끄지 않았어요. 잠시 뒤 다시 종료하거나 실행 기록을 확인해 주세요."
      showsProgress = false
      dotColor = .systemOrange
      openButton.isEnabled = false
      serverButton.title = "종료 다시 시도"
      serverButton.isEnabled = true
    case .stopped:
      statusHeadline.stringValue = "서버가 종료됐어요"
      statusDetail.stringValue = "기록은 그대로 보관되어 있어요. 언제든 다시 시작할 수 있어요."
      showsProgress = false
      dotColor = .systemGray
      openButton.isEnabled = false
      serverButton.title = "다시 시작"
      serverButton.isEnabled = true
    case let .failed(message):
      statusHeadline.stringValue = "앱을 시작하지 못했어요"
      statusDetail.stringValue = message
      showsProgress = false
      dotColor = .systemRed
      openButton.isEnabled = false
      serverButton.title = "다시 시도"
      serverButton.isEnabled = true
    }

    spinner.isHidden = !showsProgress
    statusDot.isHidden = showsProgress
    statusDot.layer?.backgroundColor = dotColor.cgColor
    if showsProgress {
      spinner.startAnimation(nil)
    } else {
      spinner.stopAnimation(nil)
    }
  }

  @objc private func openWebApp() {
    coordinator.openWebApp()
  }

  @objc private func toggleServer() {
    coordinator.toggleServer()
  }

  @objc private func showLog() {
    coordinator.showLog()
  }
}

private final class LauncherCoordinator {
  private weak var windowController: LauncherWindowController?
  private let logger: LauncherLogger
  private var serverProcess: Process?
  private var healthTimer: Timer?
  private var startupBeganAt: Date?
  private var requestedStop = false
  private var pendingFailureMessage: String?
  private var pendingApplicationTermination = false
  private var browserOpenedForCurrentRun = false
  private(set) var state: LauncherWindowController.State = .checking

  init(logger: LauncherLogger) {
    self.logger = logger
  }

  func attach(windowController: LauncherWindowController) {
    self.windowController = windowController
    render(.checking)
  }

  func begin() {
    probeHealth { [weak self] healthy in
      guard let self else { return }
      guard case .checking = self.state else { return }
      if healthy {
        self.logger.write("이미 실행 중인 로컬 서버를 확인했어요.")
        self.render(.readyExisting)
        self.openWebApp()
      } else {
        self.startServer()
      }
    }
  }

  private func startServer() {
    guard serverProcess?.isRunning != true else { return }
    requestedStop = false
    pendingFailureMessage = nil
    browserOpenedForCurrentRun = false
    render(.starting)

    let runtime: RuntimeLocation
    do {
      runtime = try RuntimeLocation.locate()
    } catch {
      fail(error)
      return
    }

    let process = Process()
    process.executableURL = runtime.node
    process.arguments = [runtime.entryPoint.path]
    process.currentDirectoryURL = runtime.directory
    let parentEnvironment = ProcessInfo.processInfo.environment
    var environment = [
      "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
      "USER": NSUserName(),
      "TMPDIR": NSTemporaryDirectory(),
      "LANG": parentEnvironment["LANG"] ?? "ko_KR.UTF-8",
      "PATH": "\(runtime.directory.path)/.runtime-node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "NODE_ENV": "production",
      "RIFF_OPEN_BROWSER": "0",
      "RIFF_PACKAGED_APP": "1",
      "RIFF_INSTALL_LOCK_ROOT": LauncherConstants.supportDirectory.path,
      "RIFF_SERVER_STATE_PATH": LauncherConstants.supportDirectory
        .appendingPathComponent("server-process.json").path,
      "RIFF_LOCAL_APP_PORT": String(LauncherConstants.appPort),
      "APP_ORIGIN": LauncherConstants.appURL.absoluteString,
    ]
    if let locale = parentEnvironment["LC_ALL"], !locale.isEmpty {
      environment["LC_ALL"] = locale
    }
    process.environment = environment
    if let output = logger.childOutputHandle() {
      process.standardOutput = output
      process.standardError = output
    }
    process.terminationHandler = { [weak self, weak process] finishedProcess in
      DispatchQueue.main.async {
        guard let self, process === self.serverProcess else { return }
        self.handleProcessExit(finishedProcess)
      }
    }

    do {
      logger.write("로컬 서버를 시작해요.")
      try process.run()
      serverProcess = process
      startupBeganAt = Date()
      scheduleHealthChecks()
    } catch {
      serverProcess = nil
      fail(error)
    }
  }

  private func scheduleHealthChecks() {
    healthTimer?.invalidate()
    let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
      self?.checkStartupProgress()
    }
    healthTimer = timer
    RunLoop.main.add(timer, forMode: .common)
    checkStartupProgress()
  }

  private func checkStartupProgress() {
    guard case .starting = state else { return }
    if let began = startupBeganAt,
       Date().timeIntervalSince(began) > LauncherConstants.startupTimeout
    {
      healthTimer?.invalidate()
      healthTimer = nil
      stopServerBecauseOfFailure(LauncherError.startupTimedOut)
      return
    }

    probeHealth { [weak self] healthy in
      guard let self, healthy, case .starting = self.state else { return }
      self.healthTimer?.invalidate()
      self.healthTimer = nil
      self.logger.write("로컬 서버가 준비됐어요.")
      self.render(.readyOwned)
      if !self.browserOpenedForCurrentRun {
        self.browserOpenedForCurrentRun = true
        self.openWebApp()
      }
    }
  }

  private func probeHealth(completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: LauncherConstants.healthURL)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 1.2
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let http = response as? HTTPURLResponse
      let validShape: Bool
      if let data,
         let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        validShape = object["configured"] is Bool && object["authenticated"] is Bool
      } else {
        validShape = false
      }
      DispatchQueue.main.async {
        completion(http?.statusCode == 200 && validShape)
      }
    }.resume()
  }

  func openWebApp() {
    switch state {
    case .readyOwned, .readyExisting:
      break
    default:
      return
    }
    logger.write("웹 화면을 열어요.")
    NSWorkspace.shared.open(LauncherConstants.appURL)
  }

  func toggleServer() {
    switch state {
    case .checking, .starting, .readyOwned:
      stopServer(forApplicationTermination: false)
    case .stopped, .failed:
      startServer()
    case .shutdownDelayed:
      stopServer(forApplicationTermination: false)
    case .readyExisting, .stopping:
      break
    }
  }

  func stopServer(forApplicationTermination: Bool) {
    healthTimer?.invalidate()
    healthTimer = nil
    guard let process = serverProcess, process.isRunning else {
      if forApplicationTermination {
        pendingApplicationTermination = false
        NSApp.reply(toApplicationShouldTerminate: true)
      } else if let pendingFailureMessage {
        self.pendingFailureMessage = nil
        requestedStop = false
        render(.failed(pendingFailureMessage))
      } else {
        render(.stopped)
      }
      return
    }

    pendingApplicationTermination = forApplicationTermination
    requestedStop = true
    render(.stopping)
    logger.write("로컬 서버에 안전한 종료 신호를 보냈어요.")
    process.terminate()

    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self, weak process] in
      guard let self, let process, process === self.serverProcess, process.isRunning else { return }
      self.logger.write("서버 종료가 지연되어 강제 종료하지 않고 실행 창을 유지해요.")
      self.render(.shutdownDelayed)
      if self.pendingApplicationTermination {
        self.pendingApplicationTermination = false
        self.presentStatusWindow()
        NSApp.reply(toApplicationShouldTerminate: false)
      }
    }
  }

  private func stopServerBecauseOfFailure(_ error: Error) {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    pendingFailureMessage = message
    logger.write("오류로 서버를 정리해요: \(message)")
    stopServer(forApplicationTermination: false)
  }

  private func handleProcessExit(_ process: Process) {
    healthTimer?.invalidate()
    healthTimer = nil
    serverProcess = nil
    logger.write("로컬 서버 프로세스가 종료됐어요. 코드: \(process.terminationStatus)")

    if pendingApplicationTermination {
      pendingApplicationTermination = false
      NSApp.reply(toApplicationShouldTerminate: true)
      return
    }
    if let pendingFailureMessage {
      self.pendingFailureMessage = nil
      requestedStop = false
      render(.failed(pendingFailureMessage))
      return
    }
    if requestedStop {
      requestedStop = false
      render(.stopped)
      return
    }

    probeHealth { [weak self] healthy in
      guard let self else { return }
      if healthy {
        self.render(.readyExisting)
        self.openWebApp()
      } else {
        self.fail(LauncherError.serverExited(process.terminationStatus))
      }
    }
  }

  private func fail(_ error: Error) {
    healthTimer?.invalidate()
    healthTimer = nil
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    logger.write("오류: \(message)")
    render(.failed(message))
  }

  private func render(_ newState: LauncherWindowController.State) {
    state = newState
    windowController?.render(newState)
  }

  private func presentStatusWindow() {
    windowController?.showWindow(nil)
    windowController?.window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func showLog() {
    NSWorkspace.shared.activateFileViewerSelecting([logger.fileURL])
  }

  func shouldTerminateApplication() -> NSApplication.TerminateReply {
    guard serverProcess?.isRunning == true else { return .terminateNow }
    if pendingApplicationTermination { return .terminateLater }
    stopServer(forApplicationTermination: true)
    return .terminateLater
  }

  func applicationWillTerminate() {
    healthTimer?.invalidate()
    if serverProcess?.isRunning == true {
      logger.write("앱 종료와 함께 서버에 종료 신호를 다시 보냈어요.")
      serverProcess?.terminate()
    }
    logger.write("실행 창을 닫았어요.")
    logger.close()
  }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
  private var windowController: LauncherWindowController?
  private var coordinator: LauncherCoordinator?
  private var signalSources: [DispatchSourceSignal] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.applicationIconImage = makeApplicationIcon()
    installMainMenu()
    installSignalHandlers()

    do {
      let logger = try LauncherLogger()
      let coordinator = LauncherCoordinator(logger: logger)
      let windowController = LauncherWindowController(coordinator: coordinator)
      self.coordinator = coordinator
      self.windowController = windowController
      coordinator.attach(windowController: windowController)
      windowController.showWindow(nil)
      windowController.window?.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      coordinator.begin()
    } catch {
      showFatalError(error)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    if !flag {
      reopenWindow()
    }
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    coordinator?.shouldTerminateApplication() ?? .terminateNow
  }

  func applicationWillTerminate(_ notification: Notification) {
    coordinator?.applicationWillTerminate()
  }

  @objc private func openWebAppFromMenu() {
    coordinator?.openWebApp()
  }

  @objc private func stopServerFromMenu() {
    coordinator?.stopServer(forApplicationTermination: false)
  }

  @objc private func reopenWindow() {
    windowController?.showWindow(nil)
    windowController?.window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func installMainMenu() {
    let mainMenu = NSMenu()
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    appMenuItem.submenu = appMenu
    appMenu.addItem(
      withTitle: "Riff Sketchbook에 관하여",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    appMenu.addItem(.separator())
    let openItem = appMenu.addItem(
      withTitle: "웹 화면 열기",
      action: #selector(openWebAppFromMenu),
      keyEquivalent: "o"
    )
    openItem.target = self
    let showItem = appMenu.addItem(
      withTitle: "실행 창 보기",
      action: #selector(reopenWindow),
      keyEquivalent: "1"
    )
    showItem.target = self
    let stopItem = appMenu.addItem(
      withTitle: "서버 종료",
      action: #selector(stopServerFromMenu),
      keyEquivalent: "."
    )
    stopItem.target = self
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Riff Sketchbook 종료",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )
    NSApp.mainMenu = mainMenu
  }

  private func installSignalHandlers() {
    for code in [SIGTERM, SIGINT] {
      signal(code, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
      source.setEventHandler {
        NSApp.terminate(nil)
      }
      source.resume()
      signalSources.append(source)
    }
  }

  private func showFatalError(_ error: Error) {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Riff Sketchbook을 열 수 없어요"
    alert.informativeText = error.localizedDescription
    alert.addButton(withTitle: "확인")
    alert.runModal()
    NSApp.terminate(nil)
  }

  private func makeApplicationIcon() -> NSImage {
    let size = NSSize(width: 512, height: 512)
    let image = NSImage(size: size)
    image.lockFocus()
    defer { image.unlockFocus() }

    let tile = NSBezierPath(
      roundedRect: NSRect(x: 28, y: 28, width: 456, height: 456),
      xRadius: 112,
      yRadius: 112
    )
    NSColor(calibratedWhite: 0.11, alpha: 1).setFill()
    tile.fill()

    let heights: [CGFloat] = [92, 176, 270, 144, 220, 112]
    let startX: CGFloat = 128
    for (index, height) in heights.enumerated() {
      let x = startX + CGFloat(index) * 51
      let bar = NSBezierPath(
        roundedRect: NSRect(x: x, y: (512 - height) / 2, width: 20, height: height),
        xRadius: 10,
        yRadius: 10
      )
      NSColor(calibratedRed: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
      bar.fill()
    }
    return image
  }
}

private let application = NSApplication.shared
private let delegate = AppDelegate()
application.delegate = delegate
withExtendedLifetime(delegate) {
  application.run()
}
