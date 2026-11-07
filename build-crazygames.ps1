# Builds the CrazyGames upload: dist\upbox-crazygames\ (index.html + images) and dist\upbox-crazygames.zip.
# Only the files the game loads are included (no admin page, servers or scripts). Upload the zip in the CrazyGames Developer Portal.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out  = Join-Path $root 'dist\upbox-crazygames'
$zip  = Join-Path $root 'dist\upbox-crazygames.zip'

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item (Join-Path $root 'boxing.html') (Join-Path $out 'index.html')
$assets = @('title-bg.jpg', 'ring-bg.webp', 'glove-blue.png', 'glove-red.png',
            'spr-in-blue.png', 'spr-in-red.png', 'spr-out-blue.png', 'spr-out-red.png', 'spr-slug-blue.png', 'spr-slug-red.png')
foreach ($a in $assets) { Copy-Item (Join-Path $root $a) (Join-Path $out $a) }

if (Test-Path $zip) { Remove-Item -Force $zip }
# OneDrive may briefly lock freshly copied files while it syncs them: retry a few times
for ($try = 1; $try -le 5; $try++) {
  try { Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -Force -ErrorAction Stop; break }
  catch { if ($try -eq 5) { throw }; Start-Sleep -Seconds 3 }
}
$size = (Get-ChildItem $out | Measure-Object Length -Sum).Sum
Write-Host ("Built {0} files, {1:N0} KB -> {2}" -f (Get-ChildItem $out).Count, ($size / 1KB), $zip)
