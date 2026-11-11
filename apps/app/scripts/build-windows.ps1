param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
Push-Location $appDir
try {
    if (-not $SkipBuild) {
        bun run tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) {
            throw "Desktop build failed with exit code $LASTEXITCODE"
        }
    }

    $portableDir = Join-Path $appDir 'src-tauri/target/release/portable'
    New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
    $executable = Join-Path $appDir 'src-tauri/target/release/ying-audio-player.exe'
    # Package only the executable, excluding any user database or cache beside it.
    $config = Get-Content -LiteralPath (Join-Path $appDir 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $archive = Join-Path $portableDir "ying-audio-player-$($config.version)-windows-x64-portable.zip"
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open("$archive.tmp", [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $executable, "Ying Audio Player/$($config.productName).exe", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    } finally {
        $zip.Dispose()
    }
    Move-Item -LiteralPath "$archive.tmp" -Destination $archive -Force
    Get-Item -LiteralPath $archive | Select-Object FullName, Length
} finally {
    Pop-Location
}
