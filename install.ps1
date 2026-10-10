[CmdletBinding()]
param(
    [string]$Version,
    [string]$InstallRoot = $env:INBOT_INSTALL_ROOT,
    [string]$BinDir = $env:INBOT_BIN_DIR,
    [string]$ReleaseBaseUrl = $env:INBOT_RELEASE_BASE_URL
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'The Windows release supports x64 only.'
}
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\inbot' }
if (-not $BinDir) { $BinDir = Join-Path $env:LOCALAPPDATA 'Programs\inbot\bin' }
foreach ($Path in @($InstallRoot, $BinDir)) {
    if (-not [System.IO.Path]::IsPathRooted($Path) -or $Path -match '[%"\r\n]') {
        throw 'Install paths must be absolute and cannot contain percent signs, quotes or newlines.'
    }
}
if (-not $Version) {
    if ($ReleaseBaseUrl) { throw '-Version is required with INBOT_RELEASE_BASE_URL.' }
    $Release = Invoke-RestMethod -Uri 'https://api.github.com/repos/kerddotdev/inbot/releases/latest'
    $Version = $Release.tag_name
}
$Version = $Version -replace '^v', ''
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'Invalid release version.' }
if (-not $ReleaseBaseUrl) {
    $ReleaseBaseUrl = "https://github.com/kerddotdev/inbot/releases/download/v$Version"
}
if ($ReleaseBaseUrl -notmatch '^(https://|http://(127\.0\.0\.1|localhost):|file://)') {
    throw 'Release URL must use HTTPS or an explicit local fixture.'
}
$Archive = "inbot-$Version-win32-x64.zip"
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
$Staging = $null
New-Item -ItemType Directory -Path $Work | Out-Null
try {
    function Get-Asset([string]$Name) {
        $Uri = "$($ReleaseBaseUrl.TrimEnd('/'))/$Name"
        $Target = Join-Path $Work $Name
        if ($Uri.StartsWith('file://')) {
            Copy-Item -LiteralPath ([Uri]$Uri).LocalPath -Destination $Target
        } else {
            Invoke-WebRequest -Uri $Uri -OutFile $Target
        }
    }
    Get-Asset 'SHA256SUMS'
    $ChecksumLines = @(Get-Content -LiteralPath (Join-Path $Work 'SHA256SUMS') | Where-Object {
        $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($Archive))$"
    })
    if ($ChecksumLines.Count -ne 1) { throw 'Archive checksum missing or duplicated.' }
    $Expected = ($ChecksumLines[0] -split '\s+')[0].ToLowerInvariant()
    Get-Asset $Archive
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Work $Archive)).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw 'SHA-256 mismatch. Nothing was installed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $Work $Archive))
    try {
        foreach ($Entry in $Zip.Entries) {
            if (-not $Entry.FullName.StartsWith('inbot/') -or $Entry.FullName -match '(^|[/\\])\.\.($|[/\\])|\\|:') {
                throw 'Archive contains an unsafe path.'
            }
        }
    } finally { $Zip.Dispose() }
    Expand-Archive -LiteralPath (Join-Path $Work $Archive) -DestinationPath $Work
    $Bundle = Join-Path $Work 'inbot'
    foreach ($File in @('inbot.cmd', 'runtime\node.exe', 'application\dist\apps\cli\src\main.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Bundle $File) -PathType Leaf)) { throw 'Incomplete release archive.' }
    }
    $Apps = Join-Path $InstallRoot 'app'
    New-Item -ItemType Directory -Force -Path $Apps, $BinDir | Out-Null
    $Destination = Join-Path $Apps $Version
    if (Test-Path -LiteralPath $Destination) {
        $Marker = Join-Path $Destination '.archive-sha256'
        if (-not (Test-Path -LiteralPath $Marker) -or (Get-Content -Raw -LiteralPath $Marker).Trim() -ne $Expected) {
            throw 'Existing version differs; choose a new install root or remove it explicitly.'
        }
    } else {
        $Staging = Join-Path $Apps ([System.IO.Path]::GetRandomFileName())
        Copy-Item -LiteralPath $Bundle -Destination $Staging -Recurse
        Set-Content -LiteralPath (Join-Path $Staging '.archive-sha256') -Value $Expected -Encoding ASCII
        Move-Item -LiteralPath $Staging -Destination $Destination
        $Staging = $null
    }
    $Shim = Join-Path $BinDir 'inbot.cmd'
    $ShimTemp = Join-Path $BinDir ([System.IO.Path]::GetRandomFileName())
    $ShimContent = @"
@echo off
setlocal
for /f "tokens=2 delims=:" %%C in ('chcp') do set "INBOT_PREVIOUS_CODEPAGE=%%C"
chcp 65001 >nul
"$Destination\runtime\node.exe" "$Destination\application\dist\apps\cli\src\main.js" %*
set "INBOT_EXIT_CODE=%errorlevel%"
chcp %INBOT_PREVIOUS_CODEPAGE% >nul
exit /b %INBOT_EXIT_CODE%
"@
    [System.IO.File]::WriteAllText($ShimTemp, ($ShimContent -replace "`r?`n", "`r`n"), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $ShimTemp -Destination $Shim -Force
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($BinDir -notin ($UserPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', (($UserPath, $BinDir | Where-Object { $_ }) -join ';'), 'User')
    }
    if ($BinDir -notin ($env:Path -split ';')) { $env:Path += ";$BinDir" }
    Write-Output "Installed Inbot $Version to $Destination"
    Write-Output 'Next: inbot serve --init'
    Write-Output 'No service was installed. Open a new terminal if needed for PATH.'
} finally {
    Remove-Item -LiteralPath $Work -Recurse -Force
    if ($Staging -and (Test-Path -LiteralPath $Staging)) { Remove-Item -LiteralPath $Staging -Recurse -Force }
}
