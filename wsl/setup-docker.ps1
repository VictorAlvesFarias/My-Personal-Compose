<#
.SYNOPSIS
    Creates the "docker" WSL distro with Docker Engine, used by My-Personal-Compose.

.DESCRIPTION
    - Installs Ubuntu as a separate distro (WSL-Vpn's Ubuntu is not touched).
    - /etc/wsl.conf: systemd (runs dockerd), root as default user, and Windows drives mounted with
      Linux permissions ("metadata"), which PostgreSQL needs for its data folder in D:\volumes.
    - Installs Docker Engine (wsl/install-docker.sh).
    Safe to run again.

.EXAMPLE
    .\wsl\setup-docker.ps1
#>
param(
    [string]$Name = 'docker',
    [string]$Location = 'D:\wsl\docker',
    [string]$Image = 'Ubuntu-24.04'
)

$ErrorActionPreference = 'Stop'
# wsl.exe prints UTF-8 instead of UTF-16, so its output can be compared.
$env:WSL_UTF8 = '1'

function Invoke-Wsl([string[]]$Arguments) {
    & wsl.exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "wsl.exe $($Arguments -join ' ') failed (exit code $LASTEXITCODE)"
    }
}

$installed = @(& wsl.exe -l -q | ForEach-Object { $_.Trim() }) -contains $Name

if (-not $installed) {
    Write-Host "==> Installing $Image as '$Name' in $Location"
    New-Item -ItemType Directory -Force $Location | Out-Null
    Invoke-Wsl @('--install', $Image, '--name', $Name, '--location', $Location, '--web-download', '--no-launch')
}

Write-Host '==> /etc/wsl.conf'
$conf = @'
[boot]
systemd=true

[user]
default=root

[automount]
options="metadata,umask=022"

[interop]
appendWindowsPath=false
'@
# Through stdin, without the CRLF PowerShell adds.
$conf | & wsl.exe -d $Name -u root --exec sh -c "tr -d '\r' > /etc/wsl.conf"
if ($LASTEXITCODE -ne 0) {
    throw 'Could not write /etc/wsl.conf'
}

# wsl.conf is read when the distro starts.
Invoke-Wsl @('--terminate', $Name)

Write-Host '==> Docker Engine'
Invoke-Wsl @('-d', $Name, '-u', 'root', '--cd', $PSScriptRoot, '--exec', 'sh', '-c', "tr -d '\r' < install-docker.sh | bash")

Write-Host ''
Write-Host "Done. Use .\compose.ps1 (in My-Personal-Compose) to run docker compose in '$Name'."
