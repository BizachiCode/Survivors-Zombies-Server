# Local development database (Windows): a private MariaDB instance for this server, built from the XAMPP binaries.
# It runs on its own port with its own data folder (.devdb/, git-ignored), so it never touches another MySQL/MariaDB
# on the machine. Production uses a regular MySQL 8+ / MariaDB 10.5+ configured through MYSQL_* in .env.
#
#   powershell -File tools/devdb.ps1 init     # first time: creates the instance, the databases and the `ctd` user, updates .env
#   powershell -File tools/devdb.ps1 start    # starts it (after a reboot)
#   powershell -File tools/devdb.ps1 stop
#   powershell -File tools/devdb.ps1 status
#
# DEVDB_BIN (default C:\xampp\mysql\bin) and DEVDB_PORT (default 3307) can be set in .env.

param([ValidateSet("init", "start", "stop", "status")][string]$Command = "status")
$ErrorActionPreference = "Stop"

$serverRoot = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $serverRoot ".env"
$dataDir = Join-Path $serverRoot ".devdb\data"
$databases = @("ctd_game_db", "ctd_e2e")

function Read-DotEnv {
    $values = @{}
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match '^\s*([A-Z0-9_]+)\s*=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
        }
    }
    return $values
}

function Set-DotEnv([hashtable]$updates) {
    $lines = if (Test-Path $envFile) { @(Get-Content $envFile) } else { @() }
    foreach ($key in $updates.Keys) {
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*$key\s*=") { $lines[$i] = "$key=$($updates[$key])"; $found = $true }
        }
        if (-not $found) { $lines += "$key=$($updates[$key])" }
    }
    [IO.File]::WriteAllText($envFile, ($lines -join "`n"), (New-Object Text.UTF8Encoding $false))
}

function New-Secret {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x')
}

$config = Read-DotEnv
$bin = if ($config["DEVDB_BIN"]) { $config["DEVDB_BIN"] } else { "C:\xampp\mysql\bin" }
$port = if ($config["DEVDB_PORT"]) { [int]$config["DEVDB_PORT"] } else { 3307 }

function Test-Port { return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

function Invoke-Sql([string]$sql) {
    $env:MYSQL_PWD = (Read-DotEnv)["DEVDB_ROOT_PASSWORD"]
    try {
        & (Join-Path $bin "mysql.exe") --protocol=TCP -h 127.0.0.1 -P $port -u root -e $sql
        if ($LASTEXITCODE -ne 0) { throw "SQL failed (exit $LASTEXITCODE)" }
    } finally {
        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
    }
}

function Start-DevDb {
    if (Test-Port) { Write-Host "[devdb] already listening on port $port"; return }
    if (-not (Test-Path (Join-Path $dataDir "my.ini"))) { throw "[devdb] not initialized: run 'tools/devdb.ps1 init' first" }
    Start-Process -FilePath (Join-Path $bin "mysqld.exe") -ArgumentList "--defaults-file=`"$dataDir\my.ini`"" -WindowStyle Hidden
    for ($i = 0; $i -lt 60 -and -not (Test-Port); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Port)) { throw "[devdb] did not start (see $dataDir\*.err)" }
    Write-Host "[devdb] running on 127.0.0.1:$port"
}

switch ($Command) {
    "init" {
        if (Test-Path $dataDir) { throw "[devdb] $dataDir already exists" }
        if (-not (Test-Path (Join-Path $bin "mysql_install_db.exe"))) { throw "[devdb] MariaDB binaries not found in $bin (set DEVDB_BIN in .env)" }
        $rootPassword = New-Secret
        $appPassword = New-Secret
        New-Item -ItemType Directory -Force (Split-Path $dataDir) | Out-Null
        & (Join-Path $bin "mysql_install_db.exe") --datadir="$dataDir" --port=$port --password="$rootPassword" --socket="ctd_devdb_$port" --silent
        if ($LASTEXITCODE -ne 0) { throw "[devdb] mysql_install_db failed" }
        Set-DotEnv @{ DEVDB_ROOT_PASSWORD = $rootPassword; DEVDB_PORT = "$port" }
        Start-DevDb

        $statements = @()
        foreach ($db in $databases) { $statements += "CREATE DATABASE IF NOT EXISTS ``$db`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" }
        foreach ($h in @("localhost", "127.0.0.1")) {
            $statements += "CREATE USER IF NOT EXISTS 'ctd'@'$h' IDENTIFIED BY '$appPassword';"
            foreach ($db in $databases) { $statements += "GRANT ALL PRIVILEGES ON ``$db``.* TO 'ctd'@'$h';" }
        }
        $statements += "FLUSH PRIVILEGES;"
        Invoke-Sql ($statements -join " ")

        Set-DotEnv @{ MYSQL_HOST = "127.0.0.1"; MYSQL_PORT = "$port"; MYSQL_USER = "ctd"; MYSQL_PASSWORD = $appPassword }
        Write-Host "[devdb] ready: databases $($databases -join ', ') and user 'ctd' (credentials written to .env)"
    }
    "start" { Start-DevDb }
    "stop" {
        if (-not (Test-Port)) { Write-Host "[devdb] not running"; return }
        $env:MYSQL_PWD = (Read-DotEnv)["DEVDB_ROOT_PASSWORD"]
        try { & (Join-Path $bin "mysqladmin.exe") --protocol=TCP -h 127.0.0.1 -P $port -u root shutdown } finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
        Write-Host "[devdb] stopped"
    }
    "status" {
        if (Test-Port) { Write-Host "[devdb] running on 127.0.0.1:$port" } else { Write-Host "[devdb] stopped (port $port)" }
    }
}
