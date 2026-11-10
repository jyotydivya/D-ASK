# Phase 7B.1b disposable fixture window (test-only). Creates ONE top-level window in its own process with a password
# Edit (ES_PASSWORD, holding a synthetic secret), a plain Edit and a Button. Shown without activation, so it never
# takes focus. Prints "READY <hwnd>" on stdout, then pumps messages until stdin closes or the process is killed.
# It receives no input from tests: tests only read it through the daemon's observation services.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Secret,
  [int]$X = 40,
  [int]$Y = 40
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DAskFixtureWin {
  public delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WNDCLASSEX { public uint cbSize, style; public WndProc lpfnWndProc; public int cbClsExtra, cbWndExtra;
    public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string lpszMenuName, lpszClassName; public IntPtr hIconSm; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern ushort RegisterClassEx(ref WNDCLASSEX c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateWindowEx(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern void PostQuitMessage(int c);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string n);
  static WndProc proc = Proc;
  static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) { if (m == 2) PostQuitMessage(0); return DefWindowProc(h, m, w, l); }
  public static IntPtr Create(string title, string secret, int x, int y) {
    IntPtr inst = GetModuleHandle(null);
    var wc = new WNDCLASSEX { cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)), lpfnWndProc = proc, hInstance = inst, hbrBackground = (IntPtr)6, lpszClassName = "DAskDesktopFixture" };
    RegisterClassEx(ref wc);
    const uint WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_BORDER = 0x00800000, WS_TABSTOP = 0x00010000;
    const uint WS_EX_NOACTIVATE = 0x08000000, WS_EX_APPWINDOW = 0x00040000;
    IntPtr hwnd = CreateWindowEx(WS_EX_NOACTIVATE | WS_EX_APPWINDOW, "DAskDesktopFixture", title, WS_OVERLAPPEDWINDOW, x, y, 420, 220, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
    CreateWindowEx(0, "STATIC", "Fixture password", WS_CHILD | WS_VISIBLE, 10, 10, 150, 20, hwnd, (IntPtr)100, inst, IntPtr.Zero);
    CreateWindowEx(0, "EDIT", secret, WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | 0x0020 /*ES_PASSWORD*/, 170, 10, 200, 22, hwnd, (IntPtr)101, inst, IntPtr.Zero);
    CreateWindowEx(0, "EDIT", "fixture plain text", WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP, 170, 40, 200, 22, hwnd, (IntPtr)102, inst, IntPtr.Zero);
    CreateWindowEx(0, "BUTTON", "Fixture OK", WS_CHILD | WS_VISIBLE | WS_TABSTOP, 170, 80, 100, 28, hwnd, (IntPtr)103, inst, IntPtr.Zero);
    ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE: never takes focus
    return hwnd;
  }
  public static void Pump() { MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); } }
}
'@
$h = [DAskFixtureWin]::Create($Title, $Secret, $X, $Y)
[Console]::Out.WriteLine("READY " + $h.ToInt64())
[Console]::Out.Flush()
[DAskFixtureWin]::Pump()
