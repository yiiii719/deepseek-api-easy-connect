# Download the Android build tools + platform jar that android/build.mjs needs.
# Only JDK 17 is required besides this (~110 MB total, from dl.google.com).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = Join-Path $root 'sdk'
$dl = Join-Path $sdk 'dl'
New-Item -ItemType Directory -Force -Path $dl | Out-Null

$items = @(
  @{ url = 'https://dl.google.com/android/repository/build-tools_r34-windows.zip'; out = 'build-tools.zip' },
  @{ url = 'https://dl.google.com/android/repository/platform-34-ext7_r03.zip'; out = 'platform.zip' }
)

foreach ($i in $items) {
  $dst = Join-Path $dl $i.out
  if (-not (Test-Path $dst)) {
    Write-Host "downloading $($i.url)"
    curl.exe -L --retry 2 -o $dst $i.url
  }
}

Write-Host 'extracting...'
tar -xf (Join-Path $dl 'build-tools.zip') -C $sdk
tar -xf (Join-Path $dl 'platform.zip') -C $sdk

Write-Host ''
Write-Host 'done. expected layout:'
Write-Host '  android/sdk/android-14/aapt2.exe, zipalign.exe, lib/d8.jar, lib/apksigner.jar'
Write-Host '  android/sdk/android-34/android.jar'
Write-Host ''
Write-Host 'next: cd android; node build.mjs'
