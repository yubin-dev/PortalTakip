[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateRange(0, 65535)][int]$WsPort = 0,
  [ValidateRange(0, 65535)][int]$AdminPort = 0,
  [string]$ExePath = '',
  [string]$InstallDirectory = '',
  [string]$LegacyPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $ExePath) { $ExePath = Join-Path $PSScriptRoot '..\dist\PortalTakip Hub.exe' }
if (-not $InstallDirectory) { $InstallDirectory = Join-Path $env:ProgramFiles 'PortalTakip' }
if (-not $LegacyPath -and $PSScriptRoot) { $LegacyPath = Join-Path $PSScriptRoot '..\data\hub.json' }
$source = (Resolve-Path -LiteralPath $ExePath).Path
$target = Join-Path $InstallDirectory 'PortalTakip Hub.exe'
$dataDirectory = Join-Path $env:ProgramData 'PortalTakip'
$configPath = Join-Path $dataDirectory 'hub.json'
$taskName = 'PortalTakip Hub'
$ruleName = 'PortalTakip-Hub-WS'

if (-not $PSCmdlet.ShouldProcess($target, 'Install or repair PortalTakip Hub')) { return }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Windows yönetici izni gerekir. PortalTakip Hub.exe dosyasını açıp UAC isteğini onaylayın.'
}
if ($WsPort -and $AdminPort -and $WsPort -eq $AdminPort) { throw 'Personel ve panel portları farklı olmalıdır.' }

$previousTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($previousTask) {
  $arguments = [string]$previousTask.Actions[0].Arguments
  if (-not $WsPort -and $arguments -match '--ws-port\s+(\d+)') { $WsPort = [int]$Matches[1] }
  if (-not $AdminPort -and $arguments -match '--admin-port\s+(\d+)') { $AdminPort = [int]$Matches[1] }
}
if (-not $WsPort) { $WsPort = 8787 }
if (-not $AdminPort) { $AdminPort = 8788 }
if ($WsPort -eq $AdminPort) { throw 'Personel ve panel portları farklı olmalıdır.' }

$wasRunning = $previousTask -and $previousTask.State -eq 'Running'
$backup = $null
$staged = $null
try {
  New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
  $existingConfig = Test-Path -LiteralPath $configPath
  if (-not $existingConfig) {
    if ($LegacyPath -and (Test-Path -LiteralPath $LegacyPath)) {
      & $source --prepare --config-path $configPath --migrate-from $LegacyPath
    } else {
      & $source --prepare --config-path $configPath
    }
    if ($LASTEXITCODE -ne 0) { throw 'Kalıcı Hub ayarları hazırlanamadı.' }
  }
  & $source --secure-config --config-path $configPath
  if ($LASTEXITCODE -ne 0) { throw 'Ayar klasörünün erişim izinleri ayarlanamadı.' }
  & $source --validate-config --config-path $configPath
  if ($LASTEXITCODE -ne 0) { throw 'Mevcut hub.json okunamıyor. Dosya korunmuştur; yedekten onarın.' }

  if ($previousTask -and $wasRunning) {
    Stop-ScheduledTask -TaskName $taskName
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { break }
      Start-Sleep -Milliseconds 250
    }
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
      throw 'Eski PortalTakip açılış görevi durmadı. Görev Zamanlayıcı üzerinden durdurup yeniden deneyin.'
    }
  }

  if ($existingConfig -and (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).state -eq 'pending') {
    & $source --rotate-setup-key --config-path $configPath
    if ($LASTEXITCODE -ne 0) { throw 'Bekleyen ilk kurulum kodu yenilenemedi.' }
  }

  foreach ($port in @($WsPort, $AdminPort)) {
    $listener = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if (-not $listener) { break }
      Start-Sleep -Milliseconds 250
    }
    if ($listener) {
      throw "Port $port başka bir işlem tarafından kullanılıyor (PID $($listener.OwningProcess)). Bu işlemi kapatıp PortalTakip Hub.exe dosyasını yeniden açın."
    }
  }

  if (-not [string]::Equals($source, $target, [StringComparison]::OrdinalIgnoreCase)) {
    $staged = Join-Path $InstallDirectory ("PortalTakip Hub." + [guid]::NewGuid().ToString('N') + '.new.exe')
    Copy-Item -LiteralPath $source -Destination $staged -ErrorAction Stop
    if (Test-Path -LiteralPath $target) {
      $backup = Join-Path $InstallDirectory ("PortalTakip Hub." + [guid]::NewGuid().ToString('N') + '.previous.exe')
      Move-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
    }
    Move-Item -LiteralPath $staged -Destination $target -ErrorAction Stop
    $staged = $null
  }

  $action = New-ScheduledTaskAction -Execute $target -Argument "--config-path `"$configPath`" --ws-port $WsPort --admin-port $AdminPort" -WorkingDirectory $InstallDirectory
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $taskPrincipal -Settings $settings -Force | Out-Null

  $oldRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if ($oldRule) {
    Set-NetFirewallRule -Name $ruleName -Enabled True -Action Allow -Profile Private -Direction Inbound | Out-Null
    $oldRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $WsPort | Out-Null
    $oldRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
  } else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'PortalTakip Hub WebSocket' -Direction Inbound `
      -Action Allow -Protocol TCP -LocalPort $WsPort -Profile Private -RemoteAddress LocalSubnet | Out-Null
  }

  Start-ScheduledTask -TaskName $taskName
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-RestMethod -Uri "http://127.0.0.1:$AdminPort/api/session" -TimeoutSec 1
      if ($null -ne $response.authenticated) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) {
    throw "Hub paneli 127.0.0.1:$AdminPort üzerinde başlamadı. Portları ve Görev Zamanlayıcı geçmişini kontrol edin; uygulamayı yeniden açarak onarın."
  }
  $panelListener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $AdminPort -ErrorAction Stop | Select-Object -First 1
  $panelOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($panelListener.OwningProcess)" -ErrorAction Stop
  if ($panelOwner.ExecutablePath -ine $target) {
    throw 'Yönetici paneli beklenen PortalTakip işlemine ait değil. Port çakışmasını giderip onarımı yeniden çalıştırın.'
  }
  if ($backup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  Write-Host "PortalTakip hazır. Yönetici paneli: http://127.0.0.1:$AdminPort"
  Write-Host "Personel portu: $WsPort. Kalıcı kurum ayarları korundu."
} catch {
  $problem = $_
  if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
  if ($backup -and (Test-Path -LiteralPath $backup)) {
    try {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
      Move-Item -LiteralPath $backup -Destination $target
      if ($wasRunning) { Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    } catch { }
  } elseif ($wasRunning) {
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  throw $problem
}
