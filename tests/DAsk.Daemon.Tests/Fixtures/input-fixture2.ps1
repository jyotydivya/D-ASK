# Complete-input disposable fixture (test-only, 2026-11-14). One WPF window (native UI Automation providers) in its own process that is
# MEANT to receive input:
#   - ListBox "pick"   (Alpha, Beta)          double-click   -> "DOUBLE <item>"
#   - Button  "menu"   with a context menu    right-click    -> "MENU"
#   - ListBox "rows"   (Row 1 .. Row 60)       wheel scroll   -> "TOP <offset>" whenever the vertical offset changes
#   - ListBox "source" (Apple, Pear) and ListBox "target": real OLE drag and drop -> "DROP <item>"
#   - TextBox "sel"    "The quick brown fox"  selection      -> "SEL <start> <length>" whenever it changes
# It reports what it actually received on stdout (and -OutFile), independently of the daemon. "READY <hwnd>" when shown.
param([Parameter(Mandatory = $true)][string]$Title, [int]$X = 100, [int]$Y = 100, [string]$OutFile)
$ErrorActionPreference = 'Stop'
function Report([string]$Line) { [Console]::Out.WriteLine($Line); [Console]::Out.Flush(); if ($OutFile) { Add-Content -Path $OutFile -Value $Line -Encoding ascii } }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$W = [System.Windows.Window]::new()
$W.Title = $Title; $W.Left = $X; $W.Top = $Y; $W.Width = 760; $W.Height = 440
$W.WindowStartupLocation = 'Manual'
$canvas = [System.Windows.Controls.Canvas]::new()
$W.Content = $canvas
function Place($el, [double]$left, [double]$top, [double]$w, [double]$h) {
    [System.Windows.Controls.Canvas]::SetLeft($el, $left); [System.Windows.Controls.Canvas]::SetTop($el, $top)
    $el.Width = $w; $el.Height = $h; [void]$canvas.Children.Add($el)
}
function Named($el, [string]$id) { [System.Windows.Automation.AutomationProperties]::SetAutomationId($el, $id); $el.Name = $id; $el }

$status = Named ([System.Windows.Controls.TextBlock]::new()) 'status'; $status.Text = 'Idle'
Place $status 20 360 600 24

$pick = Named ([System.Windows.Controls.ListBox]::new()) 'pick'
foreach ($n in 'Alpha', 'Beta') { [void]$pick.Items.Add($n) }
$pick.Add_MouseDoubleClick({ $i = $pick.SelectedItem; $status.Text = "Opened $i"; Report "DOUBLE $i" })
Place $pick 20 20 140 80

$menu = Named ([System.Windows.Controls.Button]::new()) 'menu'; $menu.Content = 'Menu'
$cm = [System.Windows.Controls.ContextMenu]::new()
$mi = [System.Windows.Controls.MenuItem]::new(); $mi.Header = 'Harmless item'; [void]$cm.Items.Add($mi)
$cm.Add_Opened({ $status.Text = 'Menu open'; Report 'MENU' })
$menu.ContextMenu = $cm
Place $menu 20 120 140 36

$rows = Named ([System.Windows.Controls.ListBox]::new()) 'rows'
for ($i = 1; $i -le 60; $i++) { [void]$rows.Items.Add("Row $i") }
$rows.AddHandler([System.Windows.Controls.ScrollViewer]::ScrollChangedEvent, [System.Windows.Controls.ScrollChangedEventHandler]{ param($s, $e)
    if ($e.VerticalChange -ne 0) { Report ("TOP {0}" -f [int]$e.VerticalOffset) } })
Place $rows 190 20 160 300

$source = Named ([System.Windows.Controls.ListBox]::new()) 'source'
foreach ($n in 'Apple', 'Pear') { [void]$source.Items.Add($n) }
$source.Add_PreviewMouseLeftButtonDown({ param($s, $e)
    $hit = $e.OriginalSource
    while ($hit -ne $null -and -not ($hit -is [System.Windows.Controls.ListBoxItem])) { $hit = [System.Windows.Media.VisualTreeHelper]::GetParent($hit) }
    if ($hit -ne $null) { [void][System.Windows.DragDrop]::DoDragDrop($source, [string]$hit.Content, [System.Windows.DragDropEffects]::Copy) }
})
Place $source 380 20 140 120

$target = Named ([System.Windows.Controls.ListBox]::new()) 'target'
$target.AllowDrop = $true
$target.Add_Drop({ param($s, $e)
    $item = [string]$e.Data.GetData([string])
    [void]$target.Items.Add("Dropped $item"); $status.Text = "Dropped $item"; Report "DROP $item"
})
Place $target 560 20 140 120

$sel = Named ([System.Windows.Controls.TextBox]::new()) 'sel'
$sel.Text = 'The quick brown fox'; $sel.IsInactiveSelectionHighlightEnabled = $true
$sel.Add_SelectionChanged({ Report ("SEL {0} {1}" -f $sel.SelectionStart, $sel.SelectionLength) })
Place $sel 380 170 300 28

$W.Add_ContentRendered({
    $h = (New-Object System.Windows.Interop.WindowInteropHelper($W)).Handle
    Report "READY $($h.ToInt64())"
})
$app = [System.Windows.Application]::new()
[void]$app.Run($W)
