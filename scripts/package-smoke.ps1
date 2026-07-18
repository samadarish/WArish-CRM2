$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appPath = Join-Path $projectRoot 'release\win-unpacked\WArish.exe'
$userDataPath = Join-Path $env:TEMP ("warish-packaged-smoke-{0}" -f [guid]::NewGuid())
$process = $null

try {
  New-Item -ItemType Directory -Path $userDataPath | Out-Null
  $process = Start-Process -FilePath $appPath -ArgumentList ("--user-data-dir={0}" -f $userDataPath) -PassThru
  Start-Sleep -Seconds 5
  $process.Refresh()
  [pscustomobject]@{
    Id = $process.Id
    ProcessName = $process.ProcessName
    Responding = $process.Responding
    HasExited = $process.HasExited
  }
  if ($process.HasExited -or -not $process.Responding) { throw 'The packaged WArish process did not remain responsive.' }
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  Remove-Item -LiteralPath $userDataPath -Recurse -Force -ErrorAction SilentlyContinue
}
