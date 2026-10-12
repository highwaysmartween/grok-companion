# Nova (Grok Companion) - one-click helper setup for a fresh Windows install.
# Safe to run more than once. Installs: Python 3.12, edge-tts, faster-whisper (+ base.en model),
# sounddevice, numpy, the official Grok CLI. Restores a "nova-data" backup if one sits next to this file.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK: $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    WARNING: $m" -ForegroundColor Yellow }

function Find-Python {
  $cands = @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { $cands += $cmd.Source }
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

Step "Python 3.12"
$py = Find-Python
if (-not $py) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    $py = Find-Python
  } else { Warn "winget not found. Install Python 3.12 from https://www.python.org/downloads/ then run this again." }
}
if ($py) { Ok "$py" } else { Warn "Python still missing - voice helpers skipped. Nova will use Windows' built-in voice instead." }

if ($py) {
  Step "Voice packages (edge-tts, faster-whisper, sounddevice)"
  & $py -m pip install --upgrade pip --quiet --disable-pip-version-check
  & $py -m pip install --upgrade edge-tts faster-whisper sounddevice numpy --disable-pip-version-check
  if ($LASTEXITCODE -eq 0) { Ok "packages installed" } else { Warn "pip reported a problem (see above)" }

  Step "Whisper speech model (base.en, ~150 MB, one-time download)"
  & $py -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8'); print('model ready')"
  if ($LASTEXITCODE -eq 0) { Ok "base.en downloaded" } else { Warn "model download failed - Nova will download it on first use" }
}

Step "Grok CLI (official installer from x.ai)"
$grok = "$env:USERPROFILE\.grok\bin\grok.exe"
if (Test-Path $grok) { Ok "already installed: $grok" }
else {
  try { Invoke-RestMethod https://x.ai/cli/install.ps1 | Invoke-Expression } catch { Warn "Grok CLI install failed: $_" }
  if (Test-Path $grok) { Ok "installed: $grok" }
}

Step "Restore Nova's saved data (settings, memory, alarms)"
$src = Join-Path $here 'nova-data'
$dst = Join-Path $env:APPDATA 'com.grok.desktopcompanion'
if (Test-Path $src) {
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $existing = Get-ChildItem $dst -ErrorAction SilentlyContinue
  if ($existing) {
    $bak = "$dst.before-restore-" + (Get-Date -Format yyyyMMdd-HHmmss)
    Copy-Item $dst $bak -Recurse -Force; Ok "kept current data at $bak"
  }
  Copy-Item (Join-Path $src '*') $dst -Recurse -Force
  Ok "restored into $dst"
} else { Write-Host "    (no nova-data folder next to this script - skipped)" }

Write-Host ""
Write-Host "All done." -ForegroundColor Green
Write-Host "NEXT: open a NEW PowerShell window and run:  grok login" -ForegroundColor Yellow
Write-Host "Then run the Nova setup .exe in this folder."
