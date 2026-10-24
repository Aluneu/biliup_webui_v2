# 用无头 Edge 逐页截图 + 收集 Console 报错，检查演示站的真实渲染效果
# 用法：pwsh -File scripts/shots.ps1 [-Port 8899]
param([int]$Port = 8899)

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { throw "Edge not found: $edge" }

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'shots'
$logDir = Join-Path $outDir 'logs'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$profileDir = Join-Path $env:TEMP ('edge-shot-' + [guid]::NewGuid().ToString('N'))

$routes = @(
  '/login/',
  '/?__login=1',
  '/streamers/?__login=1',
  '/streamers/editor/?__login=1',
  '/live/?__login=1',
  '/workbench/?__login=1',
  '/replay/?session=5001&__login=1',
  '/renders/?__login=1',
  '/upload-manager/?__login=1',
  '/upload-manager/add/?__login=1',
  '/upload-queue/?__login=1',
  '/archives/?__login=1',
  '/dashboard/?__login=1',
  '/dashboard/secrets/?__login=1',
  '/users/?__login=1',
  '/status/?__login=1',
  '/nodes/?__login=1',
  '/logviewer/?__login=1',
  '/changelog/?__login=1'
)

$summary = @()
foreach ($route in $routes) {
  $name = ($route.TrimStart('/') -replace '[/?=&]', '_') -replace '_+$', ''
  if ([string]::IsNullOrWhiteSpace($name)) { $name = 'overview' }
  $file = Join-Path $outDir ("$name.png")
  $log = Join-Path $logDir ("$name.log")
  $url = "http://127.0.0.1:$Port$route"

  $args = @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1',
    "--user-data-dir=$profileDir", '--window-size=1600,1000',
    '--virtual-time-budget=12000', '--enable-logging=stderr', '--v=0',
    "--screenshot=$file", $url
  )
  $errFile = "$log.err"
  $p = Start-Process -FilePath $edge -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardError $errFile -RedirectStandardOutput "$log.out"
  $text = ''
  if (Test-Path $errFile) { $text = Get-Content $errFile -Raw -Encoding UTF8 }
  $console = @()
  if ($text) {
    $console = ($text -split "`r?`n") | Where-Object { $_ -match 'CONSOLE|Uncaught|ERROR:' -and $_ -notmatch 'GPU|gpu_|dbus|Fontconfig|GCM|registration_request|voice_transcription|DEPRECATED' }
  }
  $console | Set-Content $log -Encoding UTF8
  $kb = 0
  if (Test-Path $file) { $kb = [math]::Round((Get-Item $file).Length / 1KB) }
  $summary += [pscustomobject]@{ Route = $route; KB = $kb; Console = $console.Count }
  if ($console.Count -gt 0) {
    Write-Output ("WARN {0,-34} {1} KB, {2} console line(s) -> {3}" -f $route, $kb, $console.Count, $log)
  } else {
    Write-Output ("OK   {0,-34} {1} KB" -f $route, $kb)
  }
}

Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
$summary | Format-Table -AutoSize
Write-Output "screenshots -> $outDir"
