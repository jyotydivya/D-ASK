# P1/P2 disposable INPUT fixture (test-only). One top-level WinForms window in its own process with a Button
# (automation id "go"), a TextBox ("notes") and a Label ("label", "Clicks: N"). Unlike desktop-fixture.ps1 it is MEANT to
# receive input: the guarded-input live test clicks and types into it, and nothing else.
# It reports what it actually received on stdout, independently of the daemon: "READY <hwnd>", "CLICKS <n>", "TEXT <len> <sha256>".
param([Parameter(Mandatory = $true)][string]$Title, [int]$X = 120, [int]$Y = 120, [string]$OutFile)
$ErrorActionPreference = 'Stop'
# Every report goes to stdout and, when -OutFile is given, to that file (the real-HUD harness reads the file).
function Report([string]$Line) { [Console]::Out.WriteLine($Line); [Console]::Out.Flush(); if ($OutFile) { Add-Content -Path $OutFile -Value $Line -Encoding ascii } }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$state = @{ clicks = 0 }
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size(460, 240)
$button = New-Object System.Windows.Forms.Button
$button.Name = 'go'; $button.Text = 'Go'; $button.Location = New-Object System.Drawing.Point(20, 20); $button.Size = New-Object System.Drawing.Size(120, 36)
$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'notes'; $box.Location = New-Object System.Drawing.Point(20, 76); $box.Size = New-Object System.Drawing.Size(400, 28)
$label = New-Object System.Windows.Forms.Label
$label.Name = 'label'; $label.Text = 'Clicks: 0'; $label.Location = New-Object System.Drawing.Point(20, 126); $label.Size = New-Object System.Drawing.Size(400, 24)
$button.Add_Click({
    $state.clicks++
    $label.Text = "Clicks: $($state.clicks)"
    Report "CLICKS $($state.clicks)"
})
$box.Add_TextChanged({
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($box.Text)
    $hash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '')
    Report "TEXT $($box.Text.Length) $hash"
})
$form.Controls.AddRange(@($button, $box, $label))
$form.Add_Shown({ Report "READY $($form.Handle.ToInt64())" })
[System.Windows.Forms.Application]::Run($form)
