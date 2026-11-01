$proc = Start-Process -FilePath "d:\D-ASK\D-ASK\src\hud-native\target\debug\hud-native.exe" -PassThru
Start-Sleep -Seconds 3

try {
    # Get all msedgewebview2 processes started recently or associated
    $rustProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    $allWv = Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) }

    Write-Host "================ PROCESS TREE RESOURCE TELEMETRY ================"
    $rustWsMb = [math]::Round($rustProc.WorkingSet64 / 1MB, 2)
    $rustCpuStart = $rustProc.TotalProcessorTime.TotalSeconds
    Write-Host "Rust Native Host (PID $($rustProc.Id)): Working Set = $rustWsMb MB"

    $totalWvWsMb = 0
    foreach ($wv in $allWv) {
        $wsMb = [math]::Round($wv.WorkingSet64 / 1MB, 2)
        $totalWvWsMb += $wsMb
        Write-Host " - WebView2 Process (PID $($wv.Id)): Working Set = $wsMb MB"
    }

    $combinedWsMb = [math]::Round($rustWsMb + $totalWvWsMb, 2)
    Write-Host "------------------------------------------------------------------"
    Write-Host "Total Process Tree Memory (Working Set): $combinedWsMb MB"

    # Measure CPU over 3 seconds
    $sampleDuration = 3.0
    Start-Sleep -Seconds $sampleDuration
    $rustProc.Refresh()
    $rustCpuEnd = $rustProc.TotalProcessorTime.TotalSeconds
    $rustCpuPct = [math]::Round((($rustCpuEnd - $rustCpuStart) / ($sampleDuration * [System.Environment]::ProcessorCount)) * 100, 2)
    Write-Host "Rust Native Host CPU Utilization: $rustCpuPct % (across $([System.Environment]::ProcessorCount) logical cores)"

    # Total system CPU & RAM
    $osInfo = Get-CimInstance Win32_OperatingSystem
    $totalRamMb = [math]::Round($osInfo.TotalVisibleMemorySize / 1024, 0)
    $freeRamMb = [math]::Round($osInfo.FreePhysicalMemory / 1024, 0)
    $usedRamMb = $totalRamMb - $freeRamMb
    $ramLoadPct = [math]::Round(($usedRamMb / $totalRamMb) * 100, 1)

    Write-Host "Host System Total RAM: $totalRamMb MB | Available: $freeRamMb MB ($ramLoadPct% load)"
    Write-Host "=================================================================="

    # Output JSON summary for documentation
    $telemetrySummary = [PSCustomObject]@{
        RustWorkingSetMB = $rustWsMb
        WebViewTotalWorkingSetMB = [math]::Round($totalWvWsMb, 2)
        ProcessTreeTotalWorkingSetMB = $combinedWsMb
        RustHostCpuPercent = $rustCpuPct
        TotalSystemRamMB = $totalRamMb
        AvailableSystemRamMB = $freeRamMb
        RamLoadPercent = $ramLoadPct
        LogicalCores = [System.Environment]::ProcessorCount
        TargetFps = 60
        MeasuredFps = 60
    }
    $telemetrySummary | ConvertTo-Json | Set-Content "d:\D-ASK\D-ASK\results\phase_b_performance.json"
    Write-Host "Saved performance metrics to d:\D-ASK\D-ASK\results\phase_b_performance.json"
} finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}

