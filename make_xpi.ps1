$src = $PSScriptRoot
$manifest = Get-Content (Join-Path $src 'manifest.json') | ConvertFrom-Json
$version = $manifest.version
$xpiPath = Join-Path $src "thunderbird-translator-v$version.xpi"

# Remove old XPI if exists
if (Test-Path $xpiPath) {
    Remove-Item $xpiPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($xpiPath, 'Create')
$fixedTimestamp = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$textExtensions = @('.html', '.js', '.json', '.svg')

function Add-DeterministicZipEntry {
    param(
        $Archive,
        [string]$FullPath,
        [string]$EntryName
    )

    $entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $fixedTimestamp
    $entryStream = $entry.Open()
    try {
        $extension = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
        if ($textExtensions -contains $extension) {
            $text = [System.IO.File]::ReadAllText($FullPath, $utf8NoBom)
            $normalized = $text.Replace("`r`n", "`n").Replace("`r", "`n")
            $bytes = $utf8NoBom.GetBytes($normalized)
            $entryStream.Write($bytes, 0, $bytes.Length)
        } else {
            $sourceStream = [System.IO.File]::OpenRead($FullPath)
            try {
                $sourceStream.CopyTo($entryStream)
            } finally {
                $sourceStream.Dispose()
            }
        }
    } finally {
        $entryStream.Dispose()
    }
}

# Files to include
$includes = @(
    'manifest.json',
    'shared\runtime-policy.js',
    'providers.js',
    'translation-router.js',
    'background.js',
    'content\translator.js',
    'content\composer.js',
    'options\options.html',
    'options\options.js',
    'icons\translate-dark.svg',
    'icons\translate-light.svg'
)

foreach ($rel in $includes) {
    $full = Join-Path $src $rel
    if (Test-Path $full) {
        Add-DeterministicZipEntry $zip $full $rel.Replace('\','/')
        Write-Host "Added: $rel"
    } else {
        Write-Host "MISSING: $rel"
    }
}

# Add all _locales files
Get-ChildItem -Path (Join-Path $src '_locales') -Recurse -File | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\','/')
    Add-DeterministicZipEntry $zip $_.FullName $rel
    Write-Host "Added: $rel"
}

$zip.Dispose()
$size = (Get-Item $xpiPath).Length
Write-Host "XPI created: thunderbird-translator-v$version.xpi ($size bytes)"
