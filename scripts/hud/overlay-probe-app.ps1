# A plain desktop application for the overlay tests: a solid-colour window with a button and a text box. It records
# every click and every change of text it really receives, so a test can tell whether input reached it.
# -TopMost puts it above ordinary windows (a maximised editor, say); the test then raises the HUD above it.
param([int]$X, [int]$Y, [int]$Width, [int]$Height, [string]$LogPath, [switch]$TopMost)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ProbeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][ProbeDpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$state = @{ clicks = 0; text = ''; activations = 0; pid = $PID; ready = $false }
function Save { $state | ConvertTo-Json -Compress | Set-Content -Encoding utf8 -Path $LogPath }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'D-ASK overlay probe'
$form.StartPosition = 'Manual'
$form.FormBorderStyle = 'None'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 110, 200)
$form.ShowInTaskbar = $true
$form.TopMost = [bool]$TopMost
# A click on the background counts too: the orb tests click wherever the orb is, not on the button.
$form.Add_MouseClick({ $state.clicks++; Save })

$button = New-Object System.Windows.Forms.Button
$button.Name = 'ProbeButton'
$button.Text = 'PROBE BUTTON'
$button.Location = New-Object System.Drawing.Point(20, 20)
$button.Size = New-Object System.Drawing.Size(180, 50)
$button.BackColor = [System.Drawing.Color]::White
$button.Add_Click({ $state.clicks++; Save })
$form.Controls.Add($button)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'ProbeText'
$box.Location = New-Object System.Drawing.Point(220, 30)
$box.Size = New-Object System.Drawing.Size(180, 30)
$box.Add_TextChanged({ $state.text = $box.Text; Save })
$form.Controls.Add($box)

$form.Add_Activated({ $state.activations++; Save })
$form.Add_Shown({ $state.ready = $true; Save; $box.Focus() })
Save
[System.Windows.Forms.Application]::Run($form)
