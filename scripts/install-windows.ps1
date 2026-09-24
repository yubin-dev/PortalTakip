[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateRange(1, 65535)][int]$WsPort = 8787,
  [ValidateRange(1, 65535)][int]$AdminPort = 8788,
  [string]$ExePath = '',
  [string]$InstallDirectory = ''
)

$ErrorActionPreference = 'Stop'
if (-not $ExePath) { $ExePath = Join-Path $PSScriptRoot '..\dist\PortalTakip Hub.exe' }
if (-not $InstallDirectory) { $InstallDirectory = Join-Path $env:ProgramFiles 'PortalTakip' }
$source = (Resolve-Path -LiteralPath $ExePath).Path
$target = Join-Path $InstallDirectory 'PortalTakip Hub.exe'
$dataDirectory = Join-Path $env:ProgramData 'PortalTakip'
$configPath = Join-Path $dataDirectory 'hub.json'
$legacyPath = Join-Path $PSScriptRoot '..\data\hub.json'
$taskName = 'PortalTakip Hub'
$ruleName = 'PortalTakip-Hub-WS'

if (-not $PSCmdlet.ShouldProcess($target, 'Install PortalTakip Hub and register startup task/firewall rule')) { return }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Bu kurulum için yönetici olarak açılmış PowerShell gerekir.'
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null

$running = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($running) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { break }
    Start-Sleep -Milliseconds 250
  }
  if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
    throw 'Eski PortalTakip görevi durmadı; EXE güncellenemedi.'
  }
}
Copy-Item -LiteralPath $source -Destination $target -Force
if (-not (Test-Path -LiteralPath $configPath)) {
  if (Test-Path -LiteralPath $legacyPath) {
    & $target --prepare --config-path $configPath --migrate-from $legacyPath
  } else {
    & $target --prepare --config-path $configPath
  }
  if ($LASTEXITCODE -ne 0) { throw 'Hub ayarları hazırlanamadı.' }
}
& $target --secure-config --config-path $configPath
if ($LASTEXITCODE -ne 0) { throw 'Ayar dosyası erişim izinleri ayarlanamadı.' }

$action = New-ScheduledTaskAction -Execute $target -Argument "--config-path `"$configPath`" --ws-port $WsPort --admin-port $AdminPort" -WorkingDirectory $InstallDirectory
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $taskPrincipal -Settings $settings -Force | Out-Null

$oldRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($oldRule) { Remove-NetFirewallRule -Name $ruleName }
New-NetFirewallRule -Name $ruleName -DisplayName 'PortalTakip Hub WebSocket' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort $WsPort -Profile Private -RemoteAddress LocalSubnet | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "PortalTakip kuruldu. Yönetici paneli: http://127.0.0.1:$AdminPort"
Write-Host "Personel portu: $WsPort. Kurum kodunu panelde ilk kurulumda alın."
Write-Host "Kalıcı ayar: $configPath. Bekleyen ilk kurulum anahtarı: $(Join-Path $dataDirectory 'setup-key.txt')"
