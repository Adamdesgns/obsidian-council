$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Install Node.js 24 or newer, then reopen this launcher." }
$defaults = @{
  CODEX_LOCAL_USAGE_READER = '1'; CLAUDE_LOCAL_USAGE_READER = '1';
  COUNCIL_GROK_PATCH_ENABLED = '1'; COUNCIL_GROK_MODEL = 'grok-4.7-build-fast';
  COUNCIL_CURSOR_ENABLED = '1'; COUNCIL_CURSOR_MODEL = 'composer-2.5'
}
foreach ($key in $defaults.Keys) {
  if (-not [Environment]::GetEnvironmentVariable($key, 'Process')) { [Environment]::SetEnvironmentVariable($key, $defaults[$key], 'Process') }
}
if (-not $env:COUNCIL_CURSOR_EXE) {
  $env:COUNCIL_CURSOR_EXE = Join-Path $env:LOCALAPPDATA 'Programs\ObsidianCouncilCursorCLI\node.exe'
  if (-not $env:COUNCIL_CURSOR_ENTRYPOINT) { $env:COUNCIL_CURSOR_ENTRYPOINT = Join-Path $env:LOCALAPPDATA 'Programs\ObsidianCouncilCursorCLI\index.js' }
}
node scripts\doctor.mjs
if ($LASTEXITCODE -ne 0) { throw 'Fix the required setup above before starting phone access.' }
$port = 4777
if ($env:COUNCIL_PORT) {
  if (-not [int]::TryParse($env:COUNCIL_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'COUNCIL_PORT must be between 1 and 65535 for phone access.' }
}
$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path -LiteralPath $tailscale)) {
  throw "Tailscale is not installed. Install it on this PC and phone, then run this launcher again."
}

$status = $null
$statusText = & $tailscale status --json 2>$null
if ($LASTEXITCODE -eq 0) { $status = $statusText | ConvertFrom-Json }
if (-not $status -or $status.BackendState -ne "Running") {
  throw "Open Tailscale and sign in on this PC, then run this launcher again."
}
$dnsName = [string]$status.Self.DNSName
$dnsName = $dnsName.TrimEnd(".")
if (-not $dnsName) {
  throw "This Tailscale device has no MagicDNS name. Enable MagicDNS in Tailscale, then run this launcher again."
}

$target = "http://127.0.0.1:$port"
$serveText = & $tailscale serve status --json 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing Tailscale Serve settings; nothing was changed.' }
$serve = $serveText | ConvertFrom-Json
$hostPort = "${dnsName}:443"
if ($serve.AllowFunnel -and $serve.AllowFunnel.$hostPort) { throw 'Public Funnel is enabled on this hostname. Council requires private Serve; resolve this separately.' }
$existing = $serve.Web.$hostPort.Handlers.'/'
if ($existing -and $existing.Proxy -ne $target) { throw 'Another app already uses the Tailscale HTTPS root. Its route was left unchanged.' }
$env:COUNCIL_ALLOWED_HOSTS = $dnsName
$env:COUNCIL_PUBLIC_URL = "https://$dnsName"
$env:COUNCIL_TAILSCALE_EXE = $tailscale
Set-Location -LiteralPath $repo
Write-Host ""
Write-Host "Starting the private phone edition of Council..."
Write-Host "Keep this window open while you use Council."
Write-Host ""
node scripts\phone-council.mjs
