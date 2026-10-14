# smtc-poll.ps1 — emits one JSON line (array of media sessions) whenever Windows'
# System Media Transport Controls state changes. Read by index.js on win32 in
# place of playerctl. Session shape: app,title,artist,album,status,position,length (seconds).
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# await a WinRT IAsyncOperation from PowerShell (no async/await in PS 5.1)
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
                   $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1" })[0]
function Await($op, $type) {
    $netTask = $asTaskGeneric.MakeGeneric($type).Invoke($null, @($op))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# AUMIDs are messy ("com.squirrel.Spotify.Spotify", "Chrome_ABC123!App") — map to
# the plain player names index.js and hide.txt use (lowercase, same as MPRIS names)
function AppName($aumid) {
    switch -Regex ($aumid) {
        "spotify" { "spotify"; break }
        "firefox" { "firefox"; break }
        "msedge"  { "msedge"; break }
        "chrome"  { "chrome"; break }
        "brave"   { "brave"; break }
        "vlc"     { "vlc"; break }
        "itunes"  { "itunes"; break }
        "tidal"   { "tidal"; break }
        "zune"    { "zunemusic"; break }
        default   { ($aumid -split "[._!]")[0].ToLower() }
    }
}

$last = ""
while ($true) {
    $sessions = @(
        foreach ($s in $manager.GetSessions()) {
            try {
                $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                if ($p.Title) {
                    $t = $s.GetTimelineProperties()
                    [ordered]@{
                        app      = AppName $s.SourceAppUserModelId
                        title    = $p.Title
                        artist   = $p.Artist
                        album    = $p.AlbumName
                        status   = $s.GetPlaybackInfo().PlaybackStatus.ToString()
                        position = [math]::Round($t.Position.TotalSeconds, 3)
                        length   = [math]::Round($t.EndTime.TotalSeconds, 3)
                    }
                }
            } catch {}
        }
    )
    $out = ConvertTo-Json -InputObject $sessions -Compress
    if ($out -ne $last) { Write-Output $out; $last = $out }
    Start-Sleep -Milliseconds 500
}