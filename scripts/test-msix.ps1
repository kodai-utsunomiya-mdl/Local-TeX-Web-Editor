#requires -Version 5.1
#requires -PSEdition Desktop

[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$TexBin = $env:LOCAL_TEX_EDITOR_TEST_TEX_BIN
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Run the MSIX installation tests on Windows.' }
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'These installation tests require a disposable GitHub Actions Windows runner.' }
$repository = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repository 'test-results\msix'
[void](New-Item -ItemType Directory -Force -Path $output)
if (-not $PackagePath) {
    $version = (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $PackagePath = Join-Path $repository ("dist\local-tex-web-editor-$version-windows-x64.msix")
}
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$temporary = Join-Path $temporaryRoot ('local-tex-web-editor-msix-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temporary)
$readyPath = Join-Path $temporary 'ready.json'
$identityPath = Join-Path $temporary 'identity.json'
$signedPackage = Join-Path $temporary 'test-signed.msix'
$certificate = $null
$installed = $null
$installAttempted = $false
$ready = $null
$applicationProcessId = 0
$defaultConfig = $null
$originalHash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash

function Write-JSONFile([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
}

function Find-SignTool {
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $versions = Get-ChildItem -LiteralPath $sdk -Directory | Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } | Sort-Object { [Version]$_.Name } -Descending
    foreach ($version in $versions) {
        $candidate = Join-Path $version.FullName 'x64\signtool.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'SignTool was not found in the Windows SDK.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace LocalTeXMSIXTest {
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
        [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
        [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray, out uint processId);
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"), ClassInterface(ClassInterfaceType.None)]
    class ApplicationActivationManager { }

    public static class Native {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ActivationContext {
            public uint Size;
            public uint Flags;
            [MarshalAs(UnmanagedType.LPWStr)] public string Source;
            public ushort ProcessorArchitecture;
            public ushort Language;
            [MarshalAs(UnmanagedType.LPWStr)] public string AssemblyDirectory;
            public IntPtr ResourceName;
            [MarshalAs(UnmanagedType.LPWStr)] public string ApplicationName;
            public IntPtr Module;
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string windowClass, string title);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
        [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool AreDpiAwarenessContextsEqual(IntPtr left, IntPtr right);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool FreeLibrary(IntPtr module);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr resource);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateActCtxW(ref ActivationContext context);
        [DllImport("kernel32.dll")] static extern void ReleaseActCtx(IntPtr context);

        public static byte[] ReadManifest(string path) {
            IntPtr module = LoadLibraryExW(path, IntPtr.Zero, 0x22); // LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE
            if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                IntPtr resource = FindResourceW(module, new IntPtr(1), new IntPtr(24)); // RT_MANIFEST / ID 1
                if (resource == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint size = SizeofResource(module, resource);
                if (size == 0 || size > 1048576) throw new InvalidOperationException("The executable manifest has an invalid size.");
                IntPtr loaded = LoadResource(module, resource);
                if (loaded == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                IntPtr data = LockResource(loaded);
                if (data == IntPtr.Zero) throw new InvalidOperationException("Windows could not access the executable manifest.");
                var result = new byte[(int)size];
                Marshal.Copy(data, result, 0, result.Length);
                return result;
            } finally { FreeLibrary(module); }
        }
        public static int ManifestActivationError(string path) {
            var request = new ActivationContext();
            request.Size = (uint)Marshal.SizeOf(typeof(ActivationContext));
            request.Flags = 8; // ACTCTX_FLAG_RESOURCE_NAME_VALID
            request.Source = path;
            request.ResourceName = new IntPtr(1);
            IntPtr context = CreateActCtxW(ref request);
            if (context == new IntPtr(-1)) return Marshal.GetLastWin32Error();
            ReleaseActCtx(context);
            return 0;
        }
        public static IntPtr WindowDpiContext(IntPtr window) {
            IntPtr context = GetWindowDpiAwarenessContext(window);
            if (context == IntPtr.Zero) throw new InvalidOperationException("The folder window has no DPI awareness context.");
            return context;
        }
        public static bool IsPerMonitorV2(IntPtr context) {
            return AreDpiAwarenessContextsEqual(context, new IntPtr(-4));
        }

        public static string Quote(string[] arguments) {
            var result = new StringBuilder();
            foreach (string argument in arguments) {
                if (result.Length > 0) result.Append(' ');
                result.Append('"');
                int slashes = 0;
                foreach (char character in argument) {
                    if (character == '\\') { slashes++; continue; }
                    result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
                    result.Append(character);
                    slashes = 0;
                }
                result.Append('\\', slashes * 2);
                result.Append('"');
            }
            return result.ToString();
        }
        public static uint Activate(string appUserModelId, string[] arguments) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            try {
                uint processId;
                // AO_NOERRORUI: return the activation failure to the test process.
                Marshal.ThrowExceptionForHR(manager.ActivateApplication(appUserModelId, Quote(arguments), 2, out processId));
                return processId;
            } finally { Marshal.FinalReleaseComObject(manager); }
        }
        public static string PackageName(uint processId) {
            IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
            if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                uint length = 0;
                int result = GetPackageFullName(process, ref length, null);
                if (result != 122) throw new Win32Exception(result); // ERROR_INSUFFICIENT_BUFFER
                var name = new StringBuilder((int)length);
                result = GetPackageFullName(process, ref length, name);
                if (result != 0) throw new Win32Exception(result);
                return name.ToString();
            } finally { CloseHandle(process); }
        }
        public static IntPtr FolderWindow(uint processId) {
            IntPtr previous = IntPtr.Zero;
            while (true) {
                IntPtr window = FindWindowEx(IntPtr.Zero, previous, "#32770", null);
                if (window == IntPtr.Zero) return IntPtr.Zero;
                previous = window;
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner == processId && IsWindowVisible(window)) return window;
            }
        }
        public static void CloseFolder(IntPtr window) {
            if (!PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        }
    }
}
'@

function Test-InstalledExecutable([string]$PackagePath, $InstalledPackage) {
    $executableName = 'local-tex-web-editor.exe'
    $installedExe = Join-Path $InstalledPackage.InstallLocation $executableName
    $unpackedExe = Join-Path $temporary $executableName
    $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        $entry = $archive.GetEntry($executableName)
        if (-not $entry) { throw "The package does not contain $executableName." }
        $source = $entry.Open()
        try {
            $destination = [IO.File]::Create($unpackedExe)
            try { $source.CopyTo($destination) } finally { $destination.Dispose() }
        } finally { $source.Dispose() }
    } finally { $archive.Dispose() }
    $installedHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
    $packagedHash = (Get-FileHash -LiteralPath $unpackedExe -Algorithm SHA256).Hash
    $bytes = [LocalTeXMSIXTest.Native]::ReadManifest($installedExe)
    [IO.File]::WriteAllBytes((Join-Path $output 'installed.manifest'), $bytes)
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $stream = [IO.MemoryStream]::new($bytes, $false)
    try { $document.Load($stream) } finally { $stream.Dispose() }
    $namespaces = [Xml.XmlNamespaceManager]::new($document.NameTable)
    $namespaces.AddNamespace('asm', 'urn:schemas-microsoft-com:asm.v1')
    $namespaces.AddNamespace('asm3', 'urn:schemas-microsoft-com:asm.v3')
    $namespaces.AddNamespace('dpi2005', 'http://schemas.microsoft.com/SMI/2005/WindowsSettings')
    $namespaces.AddNamespace('dpi2016', 'http://schemas.microsoft.com/SMI/2016/WindowsSettings')
    $dpi = $document.SelectSingleNode('/asm:assembly/asm3:application/asm3:windowsSettings/dpi2016:dpiAwareness', $namespaces)
    $legacyDpi = $document.SelectSingleNode('/asm:assembly/asm3:application/asm3:windowsSettings/dpi2005:dpiAware', $namespaces)
    $execution = $document.SelectSingleNode('/asm:assembly/asm3:trustInfo/asm3:security/asm3:requestedPrivileges/asm3:requestedExecutionLevel', $namespaces)
    $result = @{
        packageFullName = $InstalledPackage.PackageFullName
        installedPath = $installedExe
        installedSha256 = $installedHash
        packagedSha256 = $packagedHash
        hashesMatch = $installedHash -eq $packagedHash
        manifest = 'installed.manifest'
        dpiAwareness = $(if ($dpi) { $dpi.InnerText.Trim() } else { $null })
        dpiAware = $(if ($legacyDpi) { $legacyDpi.InnerText.Trim() } else { $null })
        requestedExecutionLevel = $(if ($execution) { $execution.GetAttribute('level') } else { $null })
        uiAccess = $(if ($execution) { $execution.GetAttribute('uiAccess') } else { $null })
        activationContext = @{
            method = 'CreateActCtxW with resource ID 1 from unpackaged PowerShell'
            installedError = [LocalTeXMSIXTest.Native]::ManifestActivationError($installedExe)
            unpackedCopyError = [LocalTeXMSIXTest.Native]::ManifestActivationError($unpackedExe)
        }
    }
    Write-JSONFile (Join-Path $output 'installed-executable.json') $result
    if (-not $result.hashesMatch) { throw 'The installed executable differs from the packaged executable.' }
    if ($result.dpiAwareness -ne 'PerMonitorV2, PerMonitor' -or $result.dpiAware -ne 'true/pm') {
        throw 'The installed executable does not declare Per-Monitor V2 with the expected fallback.'
    }
    if ($result.requestedExecutionLevel -ne 'asInvoker' -or $result.uiAccess -ne 'false') {
        throw 'The installed executable has an unexpected requested execution level.'
    }
}

function Test-WindowDPI([IntPtr]$Window, [uint32]$ProcessId, [string]$Observation) {
    $context = [LocalTeXMSIXTest.Native]::WindowDpiContext($Window)
    $result = @{
        processId = $ProcessId
        window = '0x' + $Window.ToInt64().ToString('X')
        dpiContext = '0x' + $context.ToInt64().ToString('X')
        perMonitorV2 = [LocalTeXMSIXTest.Native]::IsPerMonitorV2($context)
    }
    Write-JSONFile (Join-Path $output ("dpi-window-$Observation.json")) $result
    if (-not $result.perMonitorV2) { throw 'The installed application folder window is not Per-Monitor V2 aware.' }
    return $result
}

function Wait-FolderWindow([uint32]$ProcessId, [bool]$Visible, $RequestTask) {
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $deadline) {
        $window = [LocalTeXMSIXTest.Native]::FolderWindow($ProcessId)
        if (($window -ne [IntPtr]::Zero) -eq $Visible) { return $window }
        if ($Visible -and $RequestTask.IsCompleted) {
            $response = $RequestTask.GetAwaiter().GetResult()
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $response.Dispose()
            throw "The folder request ended before displaying a window: $text"
        }
        Start-Sleep -Milliseconds 50
    }
    throw "The folder selection window did not reach visible=$Visible."
}

function Test-NativePicker($Session) {
    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $client.DefaultRequestHeaders.Add('X-Local-Token', $Session.token)
    $client.DefaultRequestHeaders.Add('Origin', ([Uri]$Session.url).GetLeftPart([UriPartial]::Authority))
    $client.DefaultRequestHeaders.Add('Accept-Language', 'en')
    $cancellation = [Threading.CancellationTokenSource]::new()
    $firstBody = [Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json')
    $secondBody = $null
    try {
        $first = $client.PostAsync(([Uri]::new([Uri]$Session.url, '/api/project/pick')), $firstBody, $cancellation.Token)
        $window = Wait-FolderWindow -ProcessId $Session.pid -Visible $true -RequestTask $first
        $firstDPI = Test-WindowDPI -Window $window -ProcessId $Session.pid -Observation 'first'
        $cancellation.Cancel()
        try {
            $response = $first.GetAwaiter().GetResult()
            $response.Dispose()
            throw 'The cancelled folder request unexpectedly succeeded.'
        } catch {
            if (-not ($_.Exception.GetBaseException() -is [OperationCanceledException])) { throw }
        }
        [void](Wait-FolderWindow -ProcessId $Session.pid -Visible $false -RequestTask $first)
        $secondBody = [Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json')
        $second = $client.PostAsync(([Uri]::new([Uri]$Session.url, '/api/project/pick')), $secondBody)
        $window = Wait-FolderWindow -ProcessId $Session.pid -Visible $true -RequestTask $second
        $secondDPI = Test-WindowDPI -Window $window -ProcessId $Session.pid -Observation 'reopened'
        [LocalTeXMSIXTest.Native]::CloseFolder($window)
        $response = $second.GetAwaiter().GetResult()
        try {
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ([int]$response.StatusCode -ne 200 -or ($text | ConvertFrom-Json).path -ne '') {
                throw "Closing the folder window returned an unexpected response: $text"
            }
        } finally { $response.Dispose() }
        [void](Wait-FolderWindow -ProcessId $Session.pid -Visible $false -RequestTask $second)
        Write-JSONFile (Join-Path $output 'native-picker.json') @{
            status = 'passed'
            checks = @('packaged-process-window', 'per-monitor-v2', 'cancel-request', 'open-again', 'close-window')
            dpi = @($firstDPI, $secondDPI)
        }
    } finally {
        $cancellation.Cancel()
        $cancellation.Dispose()
        $firstBody.Dispose()
        if ($secondBody) { $secondBody.Dispose() }
        $client.Dispose()
    }
}

function Test-AppCertification([string]$PackageFullName) {
    $tool = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\App Certification Kit\appcert.exe'
    $resultFile = Join-Path $output 'certification.json'
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        Write-JSONFile $resultFile @{ status = 'not-run'; reason = 'Windows App Certification Kit is not installed on this runner.' }
        Write-Host 'Windows App Certification Kit is not installed; certification checks were not run.'
        return
    }
    & $tool reset
    if ($LASTEXITCODE -ne 0) { throw "Windows App Certification Kit reset failed with exit code $LASTEXITCODE." }
    $report = Join-Path $output 'certification.xml'
    $arguments = [LocalTeXMSIXTest.Native]::Quote(@('test', '-packagefullname', $PackageFullName, '-reportoutputpath', $report))
    $check = [Diagnostics.Process]::new()
    $check.StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $check.StartInfo.FileName = $tool
    $check.StartInfo.Arguments = $arguments
    $check.StartInfo.WorkingDirectory = Split-Path -Parent $tool
    $check.StartInfo.UseShellExecute = $false
    $check.StartInfo.RedirectStandardOutput = $true
    $check.StartInfo.RedirectStandardError = $true
    $standardOutput = $null
    $standardError = $null
    try {
        if (-not $check.Start()) { throw 'Windows App Certification Kit could not be started.' }
        # Keep the process handle from creation through ExitCode. Windows
        # PowerShell 5.1's Start-Process object can lose its exit-code state.
        [void]$check.Handle
        $standardOutput = $check.StandardOutput.ReadToEndAsync()
        $standardError = $check.StandardError.ReadToEndAsync()
        if (-not $check.WaitForExit(600000)) {
            $check.Kill()
            [void]$check.WaitForExit(5000)
            Write-JSONFile $resultFile @{ status = 'timed-out'; reason = 'Windows App Certification Kit did not finish within 10 minutes.' }
            throw 'Windows App Certification Kit did not finish within 10 minutes.'
        }
        $code = $check.ExitCode
        if ($code -isnot [int]) {
            Write-JSONFile $resultFile @{ status = 'failed'; reason = 'Windows App Certification Kit did not provide a numeric process exit code.' }
            throw 'Windows App Certification Kit did not provide a numeric process exit code.'
        }
        if (-not (Test-Path -LiteralPath $report -PathType Leaf)) {
            Write-JSONFile $resultFile @{ status = 'failed'; exitCode = $code; reason = 'Windows App Certification Kit did not create a report.' }
            throw 'Windows App Certification Kit did not create a report.'
        }
        [xml]$reportXML = Get-Content -LiteralPath $report -Raw -Encoding UTF8
        $overall = $reportXML.DocumentElement.GetAttribute('OVERALL_RESULT').Trim().ToUpperInvariant()
        $partialRun = $reportXML.DocumentElement.GetAttribute('PARTIAL_RUN').Trim().ToUpperInvariant()
        $tests = @($reportXML.SelectNodes('/REPORT/REQUIREMENTS/REQUIREMENT/TEST'))
        $findings = @($tests | Where-Object {
            $result = $_.SelectSingleNode('RESULT')
            $null -eq $result -or $result.InnerText.Trim().ToUpperInvariant() -ne 'PASS'
        })
        $complete = $partialRun -eq 'FALSE' -and $tests.Count -gt 0
        $certificationPassed = $code -eq 0 -and $complete -and $overall -eq 'PASS' -and $findings.Count -eq 0
        $dpiProcessingWarning = $false
        if ($code -eq 0 -and $complete -and $overall -eq 'WARNING' -and $findings.Count -eq 1) {
            $finding = $findings[0]
            $messages = @($finding.SelectNodes('MESSAGES/MESSAGE') | ForEach-Object { $_.GetAttribute('TEXT') })
            $isProcessingWarning = $finding.GetAttribute('INDEX') -eq '92' -and
                $finding.GetAttribute('NAME') -eq 'DPIAwarenessValidation' -and
                $finding.SelectSingleNode('RESULT').InnerText.Trim().ToUpperInvariant() -eq 'WARNING' -and
                @($messages | Where-Object { $_ -like 'Failed to process the binary *local-tex-web-editor.exe.*' }).Count -eq 1
            if ($isProcessingWarning) {
                $executable = Get-Content -LiteralPath (Join-Path $output 'installed-executable.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                $picker = Get-Content -LiteralPath (Join-Path $output 'native-picker.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                $expectedMessages = @(
                    "Failed to process the binary $($executable.installedPath).",
                    "The app $($executable.packageFullName) is not DPI Aware."
                )
                $messagesMatch = $messages.Count -eq 2 -and
                    @($messages | Where-Object { $_ -notin $expectedMessages }).Count -eq 0 -and
                    @($expectedMessages | Where-Object { $_ -notin $messages }).Count -eq 0
                $dpiProcessingWarning = $messagesMatch -and $executable.hashesMatch -eq $true -and
                    $executable.dpiAwareness -eq 'PerMonitorV2, PerMonitor' -and
                    $executable.dpiAware -eq 'true/pm' -and
                    $picker.status -eq 'passed' -and @($picker.dpi).Count -eq 2 -and
                    @($picker.dpi | Where-Object { $_.perMonitorV2 -ne $true }).Count -eq 0
            }
        }
        Write-JSONFile $resultFile @{
            status = $(if ($certificationPassed) { 'passed' } elseif ($dpiProcessingWarning) { 'warning' } else { 'failed' })
            exitCode = $code
            overallResult = $overall
            partialRun = $partialRun
            kitVersion = $reportXML.DocumentElement.GetAttribute('VERSION')
            report = 'certification.xml'
            independentDpiChecks = $(if ($dpiProcessingWarning) { @('installed-executable.json', 'installed.manifest', 'dpi-window-first.json', 'dpi-window-reopened.json', 'native-picker.json') } else { @() })
        }
        if ($code -ne 0) { throw "Windows App Certification Kit failed with exit code $code. See certification.xml." }
        if (-not $complete) { throw 'Windows App Certification Kit produced an incomplete report. See certification.xml.' }
        if ($dpiProcessingWarning) {
            $note = 'WACK reported a DPI warning because it could not process the installed executable. The installed manifest and both native folder windows passed the independent Per-Monitor V2 checks. The complete WACK report and those results are in microsoft-store-test-results.'
            Write-Host "::warning title=Windows App Certification Kit::$note"
            if ($env:GITHUB_STEP_SUMMARY) {
                "### Windows App Certification Kit`n`n$note`n`nWACK result: **WARNING**. Microsoft performs Store certification after submission." | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
            }
        } elseif (-not $certificationPassed) {
            throw "Windows App Certification Kit reported OVERALL_RESULT=$overall. See certification.xml."
        }
    } finally {
        foreach ($stream in @(
            @{ Task = $standardOutput; Name = 'certification-stdout.txt' },
            @{ Task = $standardError; Name = 'certification-stderr.txt' }
        )) {
            if ($null -eq $stream.Task) { continue }
            try {
                if ($stream.Task.Wait(5000)) {
                    $text = $stream.Task.GetAwaiter().GetResult()
                } else {
                    $text = 'The process output stream did not close within 5 seconds of the process ending.'
                }
            } catch { $text = 'Could not read the process output: ' + $_.Exception.Message }
            [IO.File]::WriteAllText((Join-Path $output $stream.Name), $text, [Text.UTF8Encoding]::new($false))
        }
        $check.Dispose()
    }
}

try {
    $zip = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        $entry = $zip.GetEntry('AppxManifest.xml')
        if (-not $entry) { throw 'AppxManifest.xml is missing from the MSIX package.' }
        $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
        try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    $name = [string]$manifest.Package.Identity.Name
    $publisher = [string]$manifest.Package.Identity.Publisher
    if ($name -ne 'LocalTeXWebEditor.Test' -or $publisher -ne 'CN=LocalTeXWebEditorTest') {
        throw 'Build this test package with --test-identity before installing it in CI.'
    }
    if (@($manifest.Package.Applications.Application).Count -ne 1 -or $manifest.Package.Applications.Application.Id -ne 'App') {
        throw 'The package must expose exactly one application with Id App.'
    }
    if (Get-AppxPackage -Name $name) { throw 'The test package is already installed on this runner.' }
    $signTool = Find-SignTool
    $certificate = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(1) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    $publicCertificate = Join-Path $temporary 'test-public.cer'
    [void](Export-Certificate -Cert $certificate -FilePath $publicCertificate)
    [void](Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople')
    Copy-Item -LiteralPath $package -Destination $signedPackage
    & $signTool sign /fd SHA256 /s My /sha1 $certificate.Thumbprint $signedPackage
    if ($LASTEXITCODE -ne 0) { throw "Signing the test package failed with exit code $LASTEXITCODE." }
    $installAttempted = $true
    Add-AppxPackage -Path $signedPackage -ForceApplicationShutdown
    $installed = Get-AppxPackage -Name $name
    if (-not $installed) { throw 'The MSIX package was not registered for the test user.' }
    Test-InstalledExecutable -PackagePath $package -InstalledPackage $installed
    $defaultConfig = Join-Path $env:LOCALAPPDATA ("Packages\" + $installed.PackageFamilyName + '\LocalState\LocalTeXEditor')
    $identity = @{ fullName = $installed.PackageFullName; familyName = $installed.PackageFamilyName; configDir = $defaultConfig; packageVersion = [string]$installed.Version }
    Write-JSONFile $identityPath $identity
    Write-JSONFile (Join-Path $output 'installed-package.json') $identity
    $arguments = @('--no-browser', '--ready-file', $readyPath)
    if ($TexBin) { $arguments += @('--tex-bin', $TexBin) }
    $applicationProcessId = [LocalTeXMSIXTest.Native]::Activate(($installed.PackageFamilyName + '!App'), $arguments)
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $readyPath) {
            try { $ready = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $ready = $null }
            if ($ready -and $ready.url -and $ready.token) { break }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw 'The installed MSIX application did not create its ready file.' }
    if ($ready.pid -ne $applicationProcessId) { throw 'The activated package and the HTTP server have different process IDs.' }
    $actualIdentity = [LocalTeXMSIXTest.Native]::PackageName($ready.pid)
    if ($actualIdentity -ne $installed.PackageFullName) { throw 'The running application does not have the installed MSIX package identity.' }
    Write-JSONFile (Join-Path $output 'activation.json') @{ processId = $ready.pid; fullName = $actualIdentity; activatedWith = 'IApplicationActivationManager' }
    if (-not (Test-Path -LiteralPath (Join-Path $defaultConfig 'active.json'))) { throw 'The app did not use its package LocalState directory for settings.' }
    Test-NativePicker $ready
    & node (Join-Path $PSScriptRoot 'test-msix.mjs') --ready-file $readyPath --identity $identityPath --temporary $temporary
    if ($LASTEXITCODE -ne 0) { throw "The packaged browser tests failed with exit code $LASTEXITCODE." }
    Test-AppCertification $installed.PackageFullName
    Write-Host 'MSIX installation, package activation, browser editing, TeX, and shutdown checks passed.'
} catch {
    [IO.File]::WriteAllText((Join-Path $output 'failure.txt'), $_.Exception.ToString(), [Text.UTF8Encoding]::new($false))
    throw
} finally {
    if ($ready) {
        try {
            Invoke-RestMethod -Uri ([Uri]::new([Uri]$ready.url, '/api/shutdown')) -Method Post -Headers @{ 'X-Local-Token' = $ready.token; Origin = ([Uri]$ready.url).GetLeftPart([UriPartial]::Authority) } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
        } catch { }
    }
    if ($applicationProcessId -gt 0) {
        try {
            $process = Get-Process -Id $applicationProcessId -ErrorAction Stop
            if (-not $process.WaitForExit(5000)) { Stop-Process -Id $applicationProcessId -Force }
        } catch { }
    }
    if ($installed -and $defaultConfig) {
        # App Certification Kit can start a new instance without --ready-file.
        # Stop that instance through the same authenticated shutdown API.
        try {
            $current = Get-Content -LiteralPath (Join-Path $defaultConfig 'active.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([LocalTeXMSIXTest.Native]::PackageName($current.pid) -eq $installed.PackageFullName) {
                $currentProcess = Get-Process -Id $current.pid -ErrorAction Stop
                try {
                    Invoke-RestMethod -Uri ([Uri]::new([Uri]$current.url, '/api/shutdown')) -Method Post -Headers @{ 'X-Local-Token' = $current.token; Origin = ([Uri]$current.url).GetLeftPart([UriPartial]::Authority) } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
                } finally {
                    if (-not $currentProcess.WaitForExit(5000)) {
                        Stop-Process -Id $current.pid -Force
                        [void]$currentProcess.WaitForExit(5000)
                    }
                    $currentProcess.Dispose()
                }
            }
        } catch { }
    }
    if ($installAttempted) {
        Get-AppxPackage -Name 'LocalTeXWebEditor.Test' | Remove-AppxPackage -ErrorAction Continue
    }
    if ($certificate) {
        Remove-Item -LiteralPath ("Cert:\LocalMachine\TrustedPeople\" + $certificate.Thumbprint) -Force -ErrorAction Continue
        Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $certificate.Thumbprint) -DeleteKey -Force -ErrorAction Continue
    }
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction Continue
    if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $originalHash) { throw 'The original unsigned MSIX package changed during testing.' }
}
