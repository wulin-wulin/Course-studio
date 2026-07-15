[CmdletBinding()]
param(
    [int]$Port = 4096,
    [string]$Hostname = "127.0.0.1",
    [string]$Cors = "http://127.0.0.1:5173"
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RootDir ".env"
$Generator = Join-Path $PSScriptRoot "gen_opencode_config.py"

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $match = [regex]::Match($trimmed, "^([^=\s]+)\s*=\s*(.*)$")
        if (-not $match.Success) { continue }

        $key = $match.Groups[1].Value
        $value = $match.Groups[2].Value.Trim()
        if ($value.Length -ge 2 -and (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        )) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

Import-DotEnv $EnvFile

# Explicit command-line parameters win; otherwise let the shared .env control
# the OpenCode listener just like the Bash launcher does.
if (-not $PSBoundParameters.ContainsKey("Port") -and $env:OPENCODE_PORT) {
    $Port = [int]$env:OPENCODE_PORT
}
if (-not $PSBoundParameters.ContainsKey("Hostname") -and $env:OPENCODE_HOSTNAME) {
    $Hostname = $env:OPENCODE_HOSTNAME
}
if (-not $PSBoundParameters.ContainsKey("Cors") -and $env:OPENCODE_CORS) {
    $Cors = $env:OPENCODE_CORS
}

# COURSE_DATA_DIR is the canonical catalog. OpenCode works in backend-managed
# per-conversation copies and the backend validates/synchronizes successful
# JSON changes back to that catalog. OPENCODE_WORKSPACE_DIR is for tests.
$DefaultWorkDir = Join-Path $RootDir "packages/backend/generated/course_agent_sessions"
$WorkDir = if ($env:OPENCODE_WORKSPACE_DIR) {
    if ([System.IO.Path]::IsPathRooted($env:OPENCODE_WORKSPACE_DIR)) {
        $env:OPENCODE_WORKSPACE_DIR
    } else {
        Join-Path $RootDir $env:OPENCODE_WORKSPACE_DIR
    }
} else {
    $DefaultWorkDir
}
$ConfigFile = Join-Path $WorkDir "opencode.json"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$opencodeCommand = Get-Command opencode.cmd -ErrorAction SilentlyContinue
if (-not $opencodeCommand) {
    $opencodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
}
$opencode = if ($opencodeCommand) { $opencodeCommand.Source } else { $null }
if (-not $opencode) {
    foreach ($candidate in @(
        (Join-Path $RootDir ".tools/bin/opencode.exe"),
        (Join-Path $RootDir ".tools/bin/opencode")
    )) {
        if (Test-Path -LiteralPath $candidate) {
            $opencode = $candidate
            break
        }
    }
}
if (-not $opencode) {
    throw "opencode was not found. Install it and make sure it is on PATH."
}

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$python = if ($pythonCommand) { $pythonCommand.Source } else { $null }
if (-not $python) {
    $pyLauncher = Get-Command "py" -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        & $pyLauncher.Source -3 $Generator $ConfigFile
    } else {
        throw "Python was not found. Python 3 is required to generate the opencode config."
    }
} else {
    & $python $Generator $ConfigFile
}
if ($LASTEXITCODE -ne 0) {
    throw "Generating the opencode config failed. Check models.json or .env model credentials."
}

$env:OPENCODE_CONFIG = $ConfigFile
Write-Host "Starting OpenCode course-data server in $WorkDir (port $Port)..."
Write-Host "Using opencode binary: $opencode"
Write-Host "Using config: $ConfigFile"
& $opencode serve --port $Port --hostname $Hostname --cors $Cors
exit $LASTEXITCODE
