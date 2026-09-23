$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path -LiteralPath $tailscale)) {
  throw "Tailscale is not installed. Install it on this PC and phone, then run this launcher again."
}

$status = $null
$statusText = & $tailscale status --json 2>$null
if ($LASTEXITCODE -eq 0) { $status = $statusText | ConvertFrom-Json }
if (-not $status -or $status.BackendState -ne "Running") {
  Write-Host "Tailscale needs to connect. Sign in in the Tailscale window; this launcher will continue automatically."
  Start-Process -FilePath "C:\Program Files\Tailscale\tailscale-ipn.exe"
  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 2
    $statusText = & $tailscale status --json 2>$null
    if ($LASTEXITCODE -eq 0) { $status = $statusText | ConvertFrom-Json }
  } while ((-not $status -or $status.BackendState -ne "Running") -and (Get-Date) -lt $deadline)
}
if (-not $status -or $status.BackendState -ne "Running") {
  throw "Tailscale did not connect within three minutes. Finish signing in, then run this launcher again."
}
$dnsName = [string]$status.Self.DNSName
$dnsName = $dnsName.TrimEnd(".")
if (-not $dnsName) {
  throw "This Tailscale device has no MagicDNS name. Enable MagicDNS in Tailscale, then run this launcher again."
}

& $tailscale serve --bg --yes http://127.0.0.1:4777
if ($LASTEXITCODE -ne 0) { throw "Tailscale Serve could not publish Council to your private tailnet." }

$env:CODEX_LOCAL_USAGE_READER = "1"
$env:CLAUDE_LOCAL_USAGE_READER = "1"
$env:COUNCIL_GROK_PATCH_ENABLED = "1"
$env:COUNCIL_GROK_MODEL = "grok-4.7-build-fast"
$env:COUNCIL_ALLOWED_HOSTS = $dnsName
$env:COUNCIL_PUBLIC_URL = "https://$dnsName"
Set-Location -LiteralPath $repo
Write-Host ""
Write-Host "Starting the private phone edition of Council..."
Write-Host "Keep this window open while you use Council."
Write-Host ""
node src\council.mjs
