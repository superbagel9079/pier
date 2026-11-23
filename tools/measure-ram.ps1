# Launches an app, times until its main window exists, waits, then sums RAM of its process tree minus Pi's processes.
# Usage: .\tools\measure-ram.ps1 -Exe target\release\pier.exe -AppArgs --model,<model> -WorkDir <folder>
eleasepier.exe -AppArgs --model,<model> -WorkDir <folder>
param([string]$Exe, [string[]]$AppArgs = @(), [string]$WorkDir = $PWD, [int]$SettleSec = 10)

function Get-Tree([int]$RootId) {
    $all = Get-CimInstance Win32_Process
    $ids = @($RootId); $i = 0
    while ($i -lt $ids.Count) {
        $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { [int]$_.ProcessId })
        $i++
    }
    $all | Where-Object { $ids -contains [int]$_.ProcessId }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = if ($AppArgs.Count) { Start-Process $Exe -ArgumentList $AppArgs -WorkingDirectory $WorkDir -PassThru } else { Start-Process $Exe -WorkingDirectory $WorkDir -PassThru }
$windowMs = $null
while ($sw.ElapsedMilliseconds -lt 30000) {
    $p.Refresh()
    if ($p.MainWindowHandle -ne 0) { $windowMs = $sw.ElapsedMilliseconds; break }
    Start-Sleep -Milliseconds 20
}
Start-Sleep -Seconds $SettleSec

$tree = Get-Tree $p.Id
# Pi is shared by both apps: leave its processes out of the app's cost.
$isPi = { param($c) $c.CommandLine -match 'pi-launcher|pi-coding-agent|--mode rpc' }
$app = @($tree | Where-Object { -not (& $isPi $_) })
$pi = @($tree | Where-Object { & $isPi $_ })
$ws = 0; $priv = 0
foreach ($c in $app) {
    $proc = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $ws += $proc.WorkingSet64; $priv += $proc.PrivateMemorySize64 }
}
[pscustomobject]@{
    WindowMs   = $windowMs
    AppProcs   = $app.Count
    PiProcs    = $pi.Count
    WorkingMB  = [math]::Round($ws / 1MB, 1)
    PrivateMB  = [math]::Round($priv / 1MB, 1)
}

$null = $p.CloseMainWindow()
if (-not $p.WaitForExit(15000)) { Stop-Process -Id $p.Id -Force }
Start-Sleep -Seconds 3
