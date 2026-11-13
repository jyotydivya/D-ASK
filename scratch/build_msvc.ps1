param(
    [string]$Target = "inspect_webview2_transparency"
)

$env:PATH = "C:\Users\divya\.cargo\bin;" + $env:PATH
$env:LIB = "D:\D-ASK\D-ASK\.xwin-sdk\crt\lib\x86_64;D:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\um\x86_64;D:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\ucrt\x86_64"
$env:RUSTFLAGS = "-C linker=rust-lld -L D:\D-ASK\D-ASK\.xwin-sdk\crt\lib\x86_64 -L D:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\um\x86_64 -L D:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\ucrt\x86_64"

Set-Location "d:\D-ASK\D-ASK\src\hud-native"
Write-Host "Running cargo build --bin $Target..."
cargo build --bin $Target

