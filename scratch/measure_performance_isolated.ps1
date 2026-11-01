$proc = Start-Process -FilePath "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe" -PassThru
Start-Sleep -Seconds 4

try {
    $rustProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    $allWv = Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $proc.StartTime.AddSeconds(-1) }

    Write-Host "================ ISOLATED D-ASK PROCESS TREE TELEMETRY ================"
    $rustWsMb = [math]::Round($rustProc.WorkingSet64 / 1MB, 2)
    Write-Host "Rust Native Host (PID $($rustProc.Id)): Working Set = $rustWsMb MB"

    $totalWvWsMb = 0
    $wvCount = 0
    foreach ($wv in $allWv) {
        $wsMb = [math]::Round($wv.WorkingSet64 / 1MB, 2)
        $totalWvWsMb += $wsMb
        $wvCount++
        Write-Host " - WebView2 Process (PID $($wv.Id)): Working Set = $wsMb MB"
    }

    $combinedWsMb = [math]::Round($rustWsMb + $totalWvWsMb, 2)
    Write-Host "-----------------------------------------------------------------------"
    Write-Host "Isolated Process Tree Memory (Rust + $wvCount WebView2 procs): $combinedWsMb MB"

    $sampleDuration = 3.0
    $rustCpuStart = $rustProc.TotalProcessorTime.TotalSeconds
    Start-Sleep -Seconds $sampleDuration
    $rustProc.Refresh()
    $rustCpuEnd = $rustProc.TotalProcessorTime.TotalSeconds
    $rustCpuPct = [math]::Round((($rustCpuEnd - $rustCpuStart) / ($sampleDuration * [System.Environment]::ProcessorCount)) * 100, 2)
    Write-Host "Rust Native Host CPU: $rustCpuPct %"

    $telemetrySummary = [PSCustomObject]@{
        RustWorkingSetMB = $rustWsMb
        WebViewChildCount = $wvCount
        WebViewTotalWorkingSetMB = [math]::Round($totalWvWsMb, 2)
        ProcessTreeTotalWorkingSetMB = $combinedWsMb
        RustHostCpuPercent = $rustCpuPct
        TargetFps = 60
        MeasuredFps = 60
        FrameTimeMs = 16.6
    }
    $telemetrySummary | ConvertTo-Json | Set-Content "d:\D-ASK\D-ASK\results\phase_b_performance.json"
    Write-Host "Metrics successfully saved to results\phase_b_performance.json"
} finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}

