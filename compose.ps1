<#
.SYNOPSIS
    Runs "docker compose" for this folder inside the "docker" WSL distro.

.EXAMPLE
    .\compose.ps1 up -d --build
    .\compose.ps1 logs -f gameout-backend
    .\compose.ps1 --profile tools run --rm sqlite-import safeguard
#>

# No param() block on purpose: in an advanced script PowerShell takes "-d" as -Debug, so
# "up -d" would run attached. $args passes every argument to docker compose as typed.
$ComposeArgs = $args
$Name = 'docker'

# WSL stops a distro a few seconds after its last wsl.exe process ends, even with dockerd running,
# and the containers stop with it. A hidden "sleep infinity" keeps the distro up.
$keepAlive = Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" |
    Where-Object { $_.CommandLine -like "*-d $Name *sleep infinity*" }

if (-not $keepAlive) {
    Start-Process wsl.exe -ArgumentList '-d', $Name, '-u', 'root', '--exec', 'sleep', 'infinity' -WindowStyle Hidden
}

& wsl.exe -d $Name -u root --cd $PSScriptRoot --exec docker compose @ComposeArgs
exit $LASTEXITCODE
