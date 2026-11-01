# BOXING local server: serves boxing.html and keeps accounts + ranking data (users.json) shared by every browser on this PC.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1   (or double-click start-server.bat)
# Keep this file pure ASCII: Windows PowerShell 5.1 misreads BOM-less UTF-8 source.
param([int]$Port = 8123)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$root = $PSScriptRoot
$dataFile = Join-Path $root 'users.json'
$sessFile = Join-Path $root 'sessions.json'
$utf8 = New-Object System.Text.UTF8Encoding $false
$idPattern = '^[A-Za-z0-9_' + [char]0xAC00 + '-' + [char]0xD7A3 + ']{3,12}$'   # 3-12 chars: letters, digits, _, Hangul
$MAX_TOKENS = 300
$MAX_LEVEL = 99

# ---------- login sessions (token -> user key). Saved to sessions.json so a server restart does not lose records of players who stay logged in ----------
$tokens = [ordered]@{}
if (Test-Path $sessFile) {
    try {
        $o = $js.DeserializeObject([System.IO.File]::ReadAllText($sessFile, $utf8))
        foreach ($k in $o.Keys) { $tokens[[string]$k] = [string]$o[$k] }
    } catch { Write-Host "sessions.json ignored: $($_.Exception.Message)" }
}
function Save-Sessions {
    [System.IO.File]::WriteAllText($sessFile, $js.Serialize($tokens), $utf8)
}
function New-Token([string]$key) {
    $t = [guid]::NewGuid().ToString('N')
    $tokens[$t] = $key
    while ($tokens.Count -gt $MAX_TOKENS) { $tokens.Remove(@($tokens.Keys)[0]) }   # drop the oldest sessions
    Save-Sessions
    return $t
}

# ---------- users (cached in memory; reloaded automatically when users.json changes on disk) ----------
$script:usersCache = @()
$script:usersStamp = ''
$script:rankVersion = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()   # grows on every ranking change (also across restarts)
function Get-Stamp {
    if (Test-Path $dataFile) { $fi = Get-Item $dataFile; return "$($fi.LastWriteTimeUtc.Ticks)-$($fi.Length)" }
    return 'none'
}
function Load-Users {
    $stamp = Get-Stamp
    if ($stamp -ne $script:usersStamp) {
        $list = @()
        if ($stamp -ne 'none') {
            $raw = [System.IO.File]::ReadAllText($dataFile, $utf8)
            if ($raw.Trim()) { $list = @($js.DeserializeObject($raw)) }
        }
        if ($script:usersStamp -ne '') { $script:rankVersion++ }   # file was edited from outside -> ranking may have changed
        $script:usersCache = $list
        $script:usersStamp = $stamp
    }
    return $script:usersCache
}
function Save-Users($list) {
    [System.IO.File]::WriteAllText($dataFile, $js.Serialize([object[]]@($list)), $utf8)
    $script:usersCache = @($list)
    $script:usersStamp = Get-Stamp
}
function Get-Hash([string]$pw, [string]$salt) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($salt + ':' + $pw))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}
$CHARS = @('outfighter', 'infighter', 'slugger')
function Get-Char($u) {
    if ($u.ContainsKey('char') -and $CHARS -contains [string]$u['char']) { return [string]$u['char'] }
    return 'outfighter'
}
function Field($data, [string]$name) {
    if ($data -and $data.ContainsKey($name) -and $null -ne $data[$name]) { return [string]$data[$name] }
    return ''
}

# ---------- ranking: highest cleared stage first; on a tie the player who reached it EARLIER ranks higher ----------
function Get-Ranked {
    $rows = New-Object System.Collections.ArrayList
    foreach ($u in @(Load-Users)) {
        $b = [int]$u['best']
        if ($b -ge 1) {
            $at = [int64]0
            if ($u.ContainsKey('bestAt') -and $null -ne $u['bestAt']) { $at = [int64]$u['bestAt'] }
            [void]$rows.Add([pscustomobject]@{ key = [string]$u['key']; id = [string]$u['id']; best = $b; at = $at })
        }
    }
    $sorted = @($rows | Sort-Object @{ Expression = 'best'; Descending = $true }, @{ Expression = 'at'; Descending = $false }, @{ Expression = 'key'; Descending = $false })
    return ,$sorted
}
function Get-RankOf($ranked, [string]$key) {
    for ($i = 0; $i -lt $ranked.Count; $i++) { if ($ranked[$i].key -eq $key) { return $i + 1 } }
    return 0
}

function Handle-Api([string]$path, $data) {
    $id = Field $data 'id'
    $pw = Field $data 'pw'
    $key = $id.ToLowerInvariant()
    $users = @(Load-Users)

    switch ($path) {
        '/api/signup' {
            if ($id -notmatch $idPattern) { return @{ ok = $false; error = 'invalid_id' } }
            if ($pw.Length -lt 4) { return @{ ok = $false; error = 'short_pw' } }
            if (@($users | Where-Object { $_['key'] -eq $key }).Count -gt 0) { return @{ ok = $false; error = 'taken' } }
            $salt = [guid]::NewGuid().ToString('N')
            $users += @{ key = $key; id = $id; salt = $salt; hash = (Get-Hash $pw $salt); best = 0; bestAt = 0; char = 'outfighter' }
            Save-Users $users
            return @{ ok = $true; id = $id; best = 0; char = 'outfighter'; token = (New-Token $key) }
        }
        '/api/login' {
            $u = @($users | Where-Object { $_['key'] -eq $key }) | Select-Object -First 1
            if (-not $u -or $u['hash'] -ne (Get-Hash $pw $u['salt'])) { return @{ ok = $false; error = 'bad_credentials' } }
            return @{ ok = $true; id = $u['id']; best = [int]$u['best']; char = (Get-Char $u); token = (New-Token $key) }
        }
        '/api/char' {
            # choose the character saved on the account (only the known ones are accepted)
            $k = $tokens[(Field $data 'token')]
            if (-not $k) { return @{ ok = $false; error = 'bad_token' } }
            $ch = Field $data 'char'
            if ($CHARS -notcontains $ch) { return @{ ok = $false; error = 'bad_char' } }
            $u = @($users | Where-Object { $_['key'] -eq $k }) | Select-Object -First 1
            if (-not $u) { return @{ ok = $false; error = 'bad_token' } }
            if ($u['char'] -ne $ch) { $u['char'] = $ch; Save-Users $users }
            return @{ ok = $true; char = $ch }
        }
        '/api/best' {
            $k = $tokens[(Field $data 'token')]
            if (-not $k) { return @{ ok = $false; error = 'bad_token' } }
            $u = @($users | Where-Object { $_['key'] -eq $k }) | Select-Object -First 1
            if (-not $u) { return @{ ok = $false; error = 'bad_token' } }
            $ls = Field $data 'level'
            $level = 0
            if ($ls -ne '') { try { $level = [int]$ls } catch { $level = 0 } }
            $cur = [int]$u['best']
            if ($level -gt $cur) {
                # Stages are cleared one after another, so an honest client can only raise its record by exactly +1 at a time
                if ($level -gt $cur + 1 -or $level -gt $MAX_LEVEL) { return @{ ok = $false; error = 'invalid_level'; best = $cur } }
                $u['best'] = $level
                $u['bestAt'] = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                Save-Users $users
                $script:rankVersion++
            }
            $ranked = Get-Ranked
            return @{ ok = $true; best = [int]$u['best']; rank = (Get-RankOf $ranked $k); version = $script:rankVersion }
        }
        '/api/ranking' {
            $limit = 10
            $ls = Field $data 'limit'
            if ($ls -ne '') { try { $l = [int]$ls; if ($l -ge 0 -and $l -le 50) { $limit = $l } } catch {} }
            $ranked = Get-Ranked
            $list = New-Object System.Collections.ArrayList
            for ($i = 0; $i -lt [Math]::Min($limit, $ranked.Count); $i++) {
                [void]$list.Add(@{ rank = $i + 1; id = $ranked[$i].id; best = $ranked[$i].best })
            }
            $me = $null
            $mk = $tokens[(Field $data 'token')]
            if ($mk) {
                $mu = @($users | Where-Object { $_['key'] -eq $mk }) | Select-Object -First 1
                if ($mu) { $me = @{ rank = (Get-RankOf $ranked $mk); id = [string]$mu['id']; best = [int]$mu['best'] } }
            }
            # NOTE: an ArrayList inside a hashtable breaks JavaScriptSerializer under PowerShell ("circular reference"), so pass a plain array
            return @{ ok = $true; version = $script:rankVersion; total = $ranked.Count; list = $list.ToArray(); me = $me }
        }
        default { return @{ ok = $false; error = 'not_found' } }
    }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "Cannot listen on port $Port (already running?)"; exit 1 }
Write-Host "BOXING server running: http://localhost:$Port/   (accounts: $dataFile)"

while ($true) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
        $req = $ctx.Request
        $res.Headers.Add('Access-Control-Allow-Origin', '*')
        $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
        $res.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        $res.Headers.Add('Cache-Control', 'no-store')
        $path = $req.Url.AbsolutePath

        if ($req.HttpMethod -eq 'OPTIONS') {
            $res.StatusCode = 204
        }
        elseif ($req.HttpMethod -eq 'GET' -and ($path -eq '/' -or $path -eq '/boxing.html')) {
            $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root 'boxing.html'))
            $res.ContentType = 'text/html; charset=utf-8'
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        elseif ($req.HttpMethod -eq 'GET' -and $path -match '^/[A-Za-z0-9_\-]+\.(webp|png|jpg|jpeg)$' -and (Test-Path (Join-Path $root $path.TrimStart('/')))) {
            # static images next to boxing.html (file name pattern is restricted, so no path traversal)
            $ext = $Matches[1]
            $res.ContentType = switch ($ext) { 'webp' { 'image/webp' } 'png' { 'image/png' } default { 'image/jpeg' } }
            $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root $path.TrimStart('/')))
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        elseif ($req.HttpMethod -eq 'POST' -and $path -like '/api/*') {
            $reader = New-Object System.IO.StreamReader($req.InputStream, $utf8)
            $data = $js.DeserializeObject($reader.ReadToEnd())
            $out = Handle-Api $path $data
            $bytes = $utf8.GetBytes($js.Serialize($out))
            $res.ContentType = 'application/json; charset=utf-8'
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        else {
            $res.StatusCode = 404
        }
    }
    catch {
        try { $res.StatusCode = 500 } catch {}
        Write-Host "Error: $($_.Exception.Message)"
    }
    finally {
        $res.Close()
    }
}
