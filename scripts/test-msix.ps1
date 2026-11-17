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
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string windowClass, string title);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);

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
        [void](Wait-FolderWindow -ProcessId $Session.pid -Visible $true -RequestTask $first)
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
        [LocalTeXMSIXTest.Native]::CloseFolder($window)
        $response = $second.GetAwaiter().GetResult()
        try {
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ([int]$response.StatusCode -ne 200 -or ($text | ConvertFrom-Json).path -ne '') {
                throw "Closing the folder window returned an unexpected response: $text"
            }
        } finally { $response.Dispose() }
        [void](Wait-FolderWindow -ProcessId $Session.pid -Visible $false -RequestTask $second)
        Write-JSONFile (Join-Path $output 'native-picker.json') @{ status = 'passed'; checks = @('packaged-process-window', 'cancel-request', 'open-again', 'close-window') }
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
    $check = Start-Process -FilePath $tool -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $output 'certification-stdout.txt') -RedirectStandardError (Join-Path $output 'certification-stderr.txt')
    try {
        if (-not $check.WaitForExit(600000)) {
            Stop-Process -Id $check.Id -Force -ErrorAction SilentlyContinue
            Write-JSONFile $resultFile @{ status = 'timed-out'; reason = 'Windows App Certification Kit did not finish within 10 minutes.' }
            throw 'Windows App Certification Kit did not finish within 10 minutes.'
        }
        $check.Refresh()
        $code = $check.ExitCode
        if (-not (Test-Path -LiteralPath $report -PathType Leaf)) {
            Write-JSONFile $resultFile @{ status = 'failed'; exitCode = $code; reason = 'Windows App Certification Kit did not create a report.' }
            throw 'Windows App Certification Kit did not create a report.'
        }
        [xml]$reportXML = Get-Content -LiteralPath $report -Raw -Encoding UTF8
        $overall = $reportXML.DocumentElement.GetAttribute('OVERALL_RESULT').Trim().ToUpperInvariant()
        $certificationPassed = $code -eq 0 -and $overall -eq 'PASS'
        Write-JSONFile $resultFile @{
            status = $(if ($certificationPassed) { 'passed' } else { 'failed' })
            exitCode = $code
            overallResult = $overall
            partialRun = $reportXML.DocumentElement.GetAttribute('PARTIAL_RUN')
            kitVersion = $reportXML.DocumentElement.GetAttribute('VERSION')
            report = 'certification.xml'
        }
        if ($code -ne 0) { throw "Windows App Certification Kit failed with exit code $code. See certification.xml." }
        if ($overall -eq '') { throw 'Windows App Certification Kit did not provide OVERALL_RESULT in its XML report.' }
        if ($overall -ne 'PASS') { throw "Windows App Certification Kit reported OVERALL_RESULT=$overall. See certification.xml." }
    } finally { $check.Dispose() }
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
