# Authenticode signature of one file, for Tauri's bundle.windows.signCommand (see
# build.yml): Tauri calls it on pier.exe before putting it in the installer, then on the
# installer, so what is installed is signed too, and the updater's signature is made of
# the signed installer. The certificate is WINDOWS_PFX (a file of the runner's temp
# folder), its password WINDOWS_CERTIFICATE_PASSWORD.
param([Parameter(Mandatory = $true)][string]$File)

$ErrorActionPreference = "Stop"
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
  Where-Object FullName -like "*x64*" | Select-Object -Last 1
if (-not $signtool) { throw "signtool.exe not found" }
& $signtool.FullName sign /f $env:WINDOWS_PFX /p $env:WINDOWS_CERTIFICATE_PASSWORD /fd sha256 `
  /tr http://timestamp.digicert.com /td sha256 $File
exit $LASTEXITCODE
