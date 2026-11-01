using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

namespace TestComUia;

[ComImport]
[Guid("ff48dba4-60ef-4201-aa87-54103eef594e")]
class CUIAutomation8 { }

public enum TreeScope
{
    TreeScope_None = 0,
    TreeScope_Element = 0x1,
    TreeScope_Children = 0x2,
    TreeScope_Descendants = 0x4,
    TreeScope_Subtree = 0x7
}

[ComImport]
[Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomation
{
    [PreserveSig] int CompareElements(IntPtr el1, IntPtr el2, [MarshalAs(UnmanagedType.Bool)] out bool areSame);
    [PreserveSig] int CompareRuntimeIds(IntPtr id1, IntPtr id2, [MarshalAs(UnmanagedType.Bool)] out bool areSame);
    [PreserveSig] int GetRootElement(out IUIAutomationElement root);
    [PreserveSig] int ElementFromHandle(IntPtr hwnd, out IUIAutomationElement element);
    [PreserveSig] int ElementFromPoint(long pt, out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
    [PreserveSig] int GetRootElementBuildCache(IntPtr cacheRequest, out IUIAutomationElement root);
    [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int ElementFromPointBuildCache(long pt, IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElementBuildCache(IntPtr cacheRequest, out IUIAutomationElement element);
    [PreserveSig] int CreateTreeWalker(IntPtr pCondition, out IntPtr walker);
    [PreserveSig] int get_ControlViewWalker(out IntPtr walker);
    [PreserveSig] int get_ContentViewWalker(out IntPtr walker);
    [PreserveSig] int get_RawViewWalker(out IntPtr walker);
    [PreserveSig] int get_RawViewCondition(out IntPtr condition);
    [PreserveSig] int get_ControlViewCondition(out IntPtr condition);
    [PreserveSig] int get_ContentViewCondition(out IntPtr condition);
    [PreserveSig] int CreateTrueCondition(out IntPtr newCondition);
}

[ComImport]
[Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElement
{
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
    [PreserveSig] int FindFirst(TreeScope scope, IntPtr condition, out IUIAutomationElement found);
    [PreserveSig] int FindAll(TreeScope scope, IntPtr condition, out IUIAutomationElementArray found);
    [PreserveSig] int FindFirstBuildCache(TreeScope scope, IntPtr condition, IntPtr cacheRequest, out IUIAutomationElement found);
    [PreserveSig] int FindAllBuildCache(TreeScope scope, IntPtr condition, IntPtr cacheRequest, out IUIAutomationElementArray found);
    [PreserveSig] int BuildUpdatedCache(IntPtr cacheRequest, out IUIAutomationElement updatedElement);
    [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object retVal);
}

[ComImport]
[Guid("14314595-b4bc-4055-95f2-58f2e42c9855")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElementArray
{
    [PreserveSig] int get_Length(out int length);
    [PreserveSig] int GetElement(int index, out IUIAutomationElement element);
}

class Program
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    static void Main()
    {
        var sw = Stopwatch.StartNew();
        var uia = (IUIAutomation)new CUIAutomation8();
        uia.GetRootElement(out var root);
        root.GetCurrentPropertyValue(30005, out var rootName);
        Console.WriteLine($"UIA initialized in {sw.ElapsedMilliseconds}ms! Root: '{rootName}'");

        IntPtr fg = GetForegroundWindow();
        var sb = new System.Text.StringBuilder(256);
        GetWindowText(fg, sb, 256);
        Console.WriteLine($"Foreground HWND: {fg}, Title: '{sb}'");

        if (fg != IntPtr.Zero)
        {
            sw.Restart();
            int hr = uia.ElementFromHandle(fg, out var fgElement);
            if (hr == 0 && fgElement != null)
            {
                fgElement.GetCurrentPropertyValue(30005, out var name);
                fgElement.GetCurrentPropertyValue(30003, out var ctype);
                fgElement.GetCurrentPropertyValue(30001, out var rectObj);
                Console.WriteLine($"ElementFromHandle took {sw.ElapsedMilliseconds}ms: Name='{name}', ControlType={ctype}");

                uia.CreateTrueCondition(out var trueCond);
                sw.Restart();
                fgElement.FindAll(TreeScope.TreeScope_Children, trueCond, out var children);
                if (children != null)
                {
                    children.get_Length(out int len);
                    Console.WriteLine($"Found {len} children in {sw.ElapsedMilliseconds}ms!");
                    for (int i = 0; i < Math.Min(len, 10); i++)
                    {
                        children.GetElement(i, out var child);
                        child.GetCurrentPropertyValue(30005, out var childName);
                        child.GetCurrentPropertyValue(30003, out var childType);
                        Console.WriteLine($"  Child [{i}]: Type={childType}, Name='{childName}'");
                    }
                }
            }
        }
    }
}
