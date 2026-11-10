using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Observation;

#region COM Interface Definitions for Windows UI Automation Core

[ComImport]
[Guid("ff48dba4-60ef-4201-aa87-54103eef594e")]
[ClassInterface(ClassInterfaceType.None)]
internal class CUIAutomation { }

internal enum TreeScope
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
internal interface IUIAutomation
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
    // Vtable order per UIAutomationClient.h: CreateCacheRequest precedes CreateTrueCondition. (It was missing, so
    // "CreateTrueCondition" called CreateCacheRequest and every FindAll received a cache request as its condition.)
    [PreserveSig] int CreateCacheRequest(out IntPtr cacheRequest);
    [PreserveSig] int CreateTrueCondition(out IntPtr newCondition);
}

[ComImport]
[Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationElement
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
internal interface IUIAutomationElementArray
{
    [PreserveSig] int get_Length(out int length);
    [PreserveSig] int GetElement(int index, out IUIAutomationElement element);
}

#endregion

public interface IUiAutomationService
{
    Task<(IReadOnlyList<UiElementInfo> Elements, string Status)> InspectWindowAsync(
        IntPtr hwnd,
        int timeoutMs = 300,
        int maxElements = 100,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Phase 7B.1b: bounded, read-only inspection of a window's UI Automation tree. Reads properties only: never a
    /// control's value, never a pattern invocation. Status is one of ok, partial (deadline or element bound reached),
    /// timeout, unavailable, worker_busy, cancelled.
    /// </summary>
    Task<UiaInspection> InspectTreeAsync(IntPtr hwnd, int maxDepth, int maxElements, int timeoutMs, CancellationToken cancellationToken = default)
        => Task.FromResult(new UiaInspection("unavailable", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, "not supported by this implementation"));
}

/// <summary>One UI Automation element, read-only properties only. <see cref="Name"/> is bounded; values are never read.</summary>
public sealed record UiaNode(
    int[]? RuntimeId,
    int Depth,
    int ParentIndex,
    string ControlType,
    string AutomationId,
    string Name,
    string ClassName,
    int[] Bounds,
    bool IsEnabled,
    bool IsOffscreen,
    bool IsPassword,
    bool IsKeyboardFocusable,
    IReadOnlyList<string> Patterns);

public sealed record UiaInspection(string Status, IReadOnlyList<UiaNode> Nodes, bool Truncated, DateTimeOffset InspectedAtUtc, string? Detail);

public class WindowsUiAutomationService : IUiAutomationService, IDisposable
{
    private readonly ILogger<WindowsUiAutomationService>? _logger;
    private readonly object _workerLock = new();
    private BlockingCollection<UiaWorkItem> _workQueue = new();
    private Thread _workerThread;
    private volatile bool _isWorkerBusy = false;
    private DateTimeOffset _busyStartTime = DateTimeOffset.MinValue;
    private bool _disposed = false;

    // Standard UIA Property IDs
    private const int UIA_BoundingRectanglePropertyId = 30001;
    private const int UIA_ControlTypePropertyId = 30003;
    // 30012 per UIAutomationClient.h (30004 is LocalizedControlType, which read "window", "button", … as the class).
    private const int UIA_ClassNamePropertyId = 30012;
    private const int UIA_NamePropertyId = 30005;
    private const int UIA_IsKeyboardFocusablePropertyId = 30009;
    private const int UIA_IsEnabledPropertyId = 30010;
    private const int UIA_AutomationIdPropertyId = 30011;

    [DllImport("ole32.dll")]
    private static extern int CoInitialize(IntPtr pvReserved);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    private sealed record UiaWorkItem(
        IntPtr Hwnd,
        int MaxElements,
        CancellationToken CancellationToken,
        TaskCompletionSource<(IReadOnlyList<UiElementInfo>, string)>? Tcs,
        Func<UiaInspection>? Tree = null,
        TaskCompletionSource<UiaInspection>? TreeTcs = null);

    public WindowsUiAutomationService(ILogger<WindowsUiAutomationService>? logger = null)
    {
        _logger = logger;

        // Initialize dedicated STA worker thread to contain all COM UIA operations
        _workerThread = new Thread(WorkerLoop)
        {
            Name = "DAsk-UiaWorker-STA",
            IsBackground = true
        };
        _workerThread.SetApartmentState(ApartmentState.STA);
        _workerThread.Start();
    }

    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    private static readonly IntPtr DpiPerMonitorAwareV2 = new(-4);

    private void WorkerLoop()
    {
        // Phase 7B.1b: UI Automation coordinates are physical pixels, whatever the hosting process's awareness.
        try { SetThreadDpiAwarenessContext(DpiPerMonitorAwareV2); } catch (EntryPointNotFoundException) { }
        CoInitialize(IntPtr.Zero);
        try
        {
            var queue = _workQueue;
            foreach (var item in queue.GetConsumingEnumerable())
            {
                if (_disposed) break;

                _isWorkerBusy = true;
                _busyStartTime = DateTimeOffset.UtcNow;
                try
                {
                    if (item.Tree != null)
                    {
                        if (item.CancellationToken.IsCancellationRequested) item.TreeTcs!.TrySetCanceled(item.CancellationToken);
                        else item.TreeTcs!.TrySetResult(item.Tree());
                        continue;
                    }

                    if (item.CancellationToken.IsCancellationRequested)
                    {
                        item.Tcs!.TrySetCanceled(item.CancellationToken);
                        continue;
                    }

                    var result = ExecuteInspection(item.Hwnd, item.MaxElements, item.CancellationToken);
                    item.Tcs!.TrySetResult(result);
                }
                catch (Exception ex)
                {
                    item.Tcs?.TrySetException(ex);
                    item.TreeTcs?.TrySetException(ex);
                }
                finally
                {
                    _isWorkerBusy = false;
                    _busyStartTime = DateTimeOffset.MinValue;
                }
            }
        }
        catch (ObjectDisposedException)
        {
            // The queue was disposed while this worker was still busy (Dispose waits only 500 ms, and a recycled worker's
            // queue is completed under it). The worker simply ends: an exception escaping a background thread would
            // terminate the whole process (observed: the test host crashed in a full-suite run on 2026-11-09).
        }
        finally
        {
            CoUninitialize();
        }
    }

    private void RecycleWorkerThread_UnderLock()
    {
        try
        {
            _workQueue.CompleteAdding();
        }
        catch { }

        _isWorkerBusy = false;
        _busyStartTime = DateTimeOffset.MinValue;
        _workQueue = new BlockingCollection<UiaWorkItem>();

        _workerThread = new Thread(WorkerLoop)
        {
            Name = "DAsk-UiaWorker-STA",
            IsBackground = true
        };
        _workerThread.SetApartmentState(ApartmentState.STA);
        _workerThread.Start();
    }

    public async Task<(IReadOnlyList<UiElementInfo> Elements, string Status)> InspectWindowAsync(
        IntPtr hwnd,
        int timeoutMs = 300,
        int maxElements = 100,
        CancellationToken cancellationToken = default)
    {
        if (hwnd == IntPtr.Zero)
        {
            return (Array.Empty<UiElementInfo>(), "NoWindow");
        }

        if (_disposed)
        {
            return (InspectWin32ControlsFallback(hwnd, maxElements), "ServiceDisposedFallbackWin32");
        }

        // Bounded worker containment: Check if worker is stalled and needs recycling
        if (_isWorkerBusy)
        {
            lock (_workerLock)
            {
                if (_isWorkerBusy && (DateTimeOffset.UtcNow - _busyStartTime) > TimeSpan.FromSeconds(5))
                {
                    _logger?.LogWarning("UIA worker stalled for >5000ms. Abandoning stalled worker thread and recycling STA worker.");
                    RecycleWorkerThread_UnderLock();
                }
            }

            if (_isWorkerBusy)
            {
                _logger?.LogWarning("UIA worker is busy handling a previous stalled window. Using immediate Win32 fallback.");
                return (InspectWin32ControlsFallback(hwnd, maxElements), "WorkerBusyFallbackWin32");
            }
        }

        var tcs = new TaskCompletionSource<(IReadOnlyList<UiElementInfo>, string)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var workItem = new UiaWorkItem(hwnd, maxElements, cancellationToken, tcs);

        BlockingCollection<UiaWorkItem> currentQueue;
        lock (_workerLock)
        {
            currentQueue = _workQueue;
        }

        try
        {
            currentQueue.Add(workItem, cancellationToken);
        }
        catch (InvalidOperationException)
        {
            return (InspectWin32ControlsFallback(hwnd, maxElements), "QueueClosedFallbackWin32");
        }

        var completedTask = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs, cancellationToken));
        if (completedTask == tcs.Task)
        {
            try
            {
                return await tcs.Task;
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "UIA inspection encountered an unhandled error. Falling back to Win32 controls.");
                return (InspectWin32ControlsFallback(hwnd, maxElements), "FallbackWin32");
            }
        }
        else
        {
            _logger?.LogWarning("UIA inspection timed out after {TimeoutMs}ms for HWND {Hwnd}. Using Win32 fallback.", timeoutMs, hwnd);
            return (InspectWin32ControlsFallback(hwnd, maxElements), "PartialUiaTimeout");
        }
    }

    // ── Phase 7B.1b: bounded tree inspection ──────────────────────────────────────────────────────────────────────

    private const int UIA_RuntimeIdPropertyId = 30000;
    private const int UIA_IsPasswordPropertyId = 30019;
    private const int UIA_IsOffscreenPropertyId = 30022;
    public const int MaxNameChars = 160;

    // Pattern availability properties: reported only, never used to invoke anything.
    private static readonly (int Id, string Name)[] PatternProperties =
    {
        (30028, "ExpandCollapse"), (30031, "Invoke"), (30033, "RangeValue"), (30034, "Scroll"),
        (30036, "SelectionItem"), (30037, "Selection"), (30040, "Text"), (30041, "Toggle"),
        (30043, "Value"), (30044, "Window"),
    };

    public async Task<UiaInspection> InspectTreeAsync(IntPtr hwnd, int maxDepth, int maxElements, int timeoutMs, CancellationToken cancellationToken = default)
    {
        if (hwnd == IntPtr.Zero) return new UiaInspection("unavailable", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, "no window");
        if (_disposed) return new UiaInspection("unavailable", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, "service disposed");
        maxDepth = Math.Clamp(maxDepth, 0, 6);
        maxElements = Math.Clamp(maxElements, 1, 400);
        timeoutMs = Math.Clamp(timeoutMs, 50, 10_000);

        if (_isWorkerBusy)
        {
            lock (_workerLock)
            {
                if (_isWorkerBusy && (DateTimeOffset.UtcNow - _busyStartTime) > TimeSpan.FromSeconds(5)) RecycleWorkerThread_UnderLock();
            }
            if (_isWorkerBusy) return new UiaInspection("worker_busy", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, "UI Automation is busy with another window");
        }

        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        var tcs = new TaskCompletionSource<UiaInspection>(TaskCreationOptions.RunContinuationsAsynchronously);
        var item = new UiaWorkItem(hwnd, maxElements, cancellationToken, null,
            () => ExecuteTree(hwnd, maxDepth, maxElements, deadline, cancellationToken), tcs);
        BlockingCollection<UiaWorkItem> q;
        lock (_workerLock) q = _workQueue;
        try { q.Add(item, cancellationToken); }
        catch (OperationCanceledException) { return new UiaInspection("cancelled", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, null); }
        catch (InvalidOperationException) { return new UiaInspection("unavailable", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, "worker queue closed"); }

        // The tree walk honours the deadline itself; the extra grace only covers a provider that hangs inside one call.
        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs + 750, CancellationToken.None));
        if (done != tcs.Task) return new UiaInspection("timeout", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, $"no answer within {timeoutMs} ms");
        try { return await tcs.Task; }
        catch (OperationCanceledException) { return new UiaInspection("cancelled", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, null); }
        catch (Exception ex) { return new UiaInspection("unavailable", Array.Empty<UiaNode>(), false, DateTimeOffset.UtcNow, ex.GetType().Name); }
    }

    private static object? Prop(IUIAutomationElement e, int id)
    {
        try { return e.GetCurrentPropertyValue(id, out var v) == 0 ? v : null; } catch { return null; }
    }

    private static UiaNode ReadNode(IUIAutomationElement e, int depth, int parent)
    {
        string name = Prop(e, UIA_NamePropertyId) as string ?? string.Empty;
        if (name.Length > MaxNameChars) name = name[..MaxNameChars] + "…";
        // UIA reports left, top, width, height; reported as left, top, right, bottom like the window bounds.
        int[] bounds = Prop(e, UIA_BoundingRectanglePropertyId) is double[] r && r.Length == 4
            ? new[] { (int)Math.Round(r[0]), (int)Math.Round(r[1]), (int)Math.Round(r[0] + r[2]), (int)Math.Round(r[1] + r[3]) }
            : new[] { 0, 0, 0, 0 };
        var patterns = new List<string>();
        foreach (var (id, pname) in PatternProperties)
            if (Prop(e, id) is true) patterns.Add(pname);
        return new UiaNode(
            Prop(e, UIA_RuntimeIdPropertyId) as int[],
            depth,
            parent,
            Prop(e, UIA_ControlTypePropertyId) is int ct ? MapControlTypeIdToString(ct) : "Unknown",
            Prop(e, UIA_AutomationIdPropertyId) as string ?? string.Empty,
            name,
            Prop(e, UIA_ClassNamePropertyId) as string ?? string.Empty,
            bounds,
            Prop(e, UIA_IsEnabledPropertyId) is true,
            Prop(e, UIA_IsOffscreenPropertyId) is true,
            Prop(e, UIA_IsPasswordPropertyId) is true,
            Prop(e, UIA_IsKeyboardFocusablePropertyId) is true,
            patterns);
    }

    private UiaInspection ExecuteTree(IntPtr hwnd, int maxDepth, int maxElements, DateTime deadline, CancellationToken ct)
    {
        IUIAutomation? uia = null;
        IntPtr cond = IntPtr.Zero;
        var nodes = new List<UiaNode>();
        var frontier = new Queue<(IUIAutomationElement El, int Depth, int Index)>();
        bool truncated = false, partial = false;
        int failures = 0;
        string? lastFailure = null;
        try
        {
            try { uia = (IUIAutomation)new CUIAutomation(); }
            catch (Exception ex) { return new UiaInspection("unavailable", nodes, false, DateTimeOffset.UtcNow, ex.GetType().Name); }
            if (uia.ElementFromHandle(hwnd, out var root) != 0 || root == null)
                return new UiaInspection("unavailable", nodes, false, DateTimeOffset.UtcNow, "the window exposes no UI Automation element");
            if (uia.CreateTrueCondition(out cond) != 0 || cond == IntPtr.Zero)
            {
                Marshal.ReleaseComObject(root);
                return new UiaInspection("unavailable", nodes, false, DateTimeOffset.UtcNow, "no tree condition");
            }

            nodes.Add(ReadNode(root, 0, -1));
            frontier.Enqueue((root, 0, 0));
            while (frontier.Count > 0)
            {
                var (el, depth, index) = frontier.Dequeue();
                try
                {
                    if (ct.IsCancellationRequested) return new UiaInspection("cancelled", nodes, truncated, DateTimeOffset.UtcNow, null);
                    if (DateTime.UtcNow >= deadline) { partial = true; continue; }
                    if (depth >= maxDepth || truncated) continue;
                    int hrFind = el.FindAll(TreeScope.TreeScope_Children, cond, out var children);
                    if (hrFind != 0 || children == null)
                    {
                        // A failed child query is a gap in the tree, never silently reported as "ok".
                        partial = true;
                        failures++;
                        lastFailure = $"children of element {index} could not be read (0x{hrFind:X8})";
                        continue;
                    }
                    try
                    {
                        children.get_Length(out int count);
                        for (int i = 0; i < count; i++)
                        {
                            if (nodes.Count >= maxElements) { truncated = true; break; }
                            if (DateTime.UtcNow >= deadline) { partial = true; break; }
                            if (children.GetElement(i, out var child) != 0 || child == null) continue;
                            nodes.Add(ReadNode(child, depth + 1, index));
                            frontier.Enqueue((child, depth + 1, nodes.Count - 1));
                        }
                    }
                    finally { Marshal.ReleaseComObject(children); }
                }
                finally { if (Marshal.IsComObject(el)) Marshal.ReleaseComObject(el); }
            }
            return new UiaInspection(partial || truncated ? "partial" : "ok", nodes, truncated, DateTimeOffset.UtcNow,
                failures > 0 ? $"{failures} part(s) of the tree could not be read; last: {lastFailure}"
                : partial ? "the inspection deadline was reached" : truncated ? $"stopped at {maxElements} elements" : null);
        }
        finally
        {
            while (frontier.Count > 0) { var (el, _, _) = frontier.Dequeue(); if (Marshal.IsComObject(el)) Marshal.ReleaseComObject(el); }
            if (cond != IntPtr.Zero) Marshal.Release(cond);
            if (uia != null && Marshal.IsComObject(uia)) Marshal.ReleaseComObject(uia);
        }
    }

    private (IReadOnlyList<UiElementInfo> Elements, string Status) ExecuteInspection(
        IntPtr hwnd,
        int maxElements,
        CancellationToken cancellationToken)
    {
        IUIAutomation? uia = null;
        IUIAutomationElement? rootElement = null;
        IntPtr trueCond = IntPtr.Zero;
        IUIAutomationElementArray? array = null;

        try
        {
            try
            {
                uia = (IUIAutomation)new CUIAutomation();
            }
            catch (Exception ex)
            {
                _logger?.LogWarning(ex, "Failed to instantiate CUIAutomation in STA worker.");
                return (InspectWin32ControlsFallback(hwnd, maxElements), "FallbackWin32");
            }

            if (uia == null)
            {
                return (InspectWin32ControlsFallback(hwnd, maxElements), "FallbackWin32");
            }

            int hr = uia.ElementFromHandle(hwnd, out rootElement);
            if (hr != 0 || rootElement == null)
            {
                return (InspectWin32ControlsFallback(hwnd, maxElements), "FallbackWin32");
            }

            var list = new List<UiElementInfo>();

            // Include root window itself
            var rootInfo = ExtractElementInfo(rootElement, "RootWindow");
            if (rootInfo != null)
            {
                list.Add(rootInfo);
            }

            // Query interactive children / descendants
            hr = uia.CreateTrueCondition(out trueCond);
            if (hr == 0 && trueCond != IntPtr.Zero)
            {
                hr = rootElement.FindAll(TreeScope.TreeScope_Children, trueCond, out array);
                if (hr == 0 && array != null)
                {
                    array.get_Length(out int count);
                    int limit = Math.Min(count, maxElements);
                    for (int i = 0; i < limit; i++)
                    {
                        if (cancellationToken.IsCancellationRequested) break;

                        IUIAutomationElement? child = null;
                        try
                        {
                            if (array.GetElement(i, out child) == 0 && child != null)
                            {
                                var childInfo = ExtractElementInfo(child, $"elem_{i}");
                                if (childInfo != null)
                                {
                                    list.Add(childInfo);
                                }
                            }
                        }
                        finally
                        {
                            if (child != null && Marshal.IsComObject(child))
                            {
                                Marshal.ReleaseComObject(child);
                            }
                        }
                    }
                }
            }

            // If UIA yielded only the root window, supplement with Win32 child controls
            if (list.Count <= 1)
            {
                var fallbackList = InspectWin32ControlsFallback(hwnd, maxElements);
                foreach (var fb in fallbackList)
                {
                    if (!list.Any(e => e.StableId == fb.StableId))
                    {
                        list.Add(fb);
                    }
                }
            }

            return (list as IReadOnlyList<UiElementInfo>, "Success");
        }
        finally
        {
            // Deterministic COM cleanup for every acquired interface pointer and RCW
            if (array != null && Marshal.IsComObject(array))
            {
                Marshal.ReleaseComObject(array);
            }
            if (trueCond != IntPtr.Zero)
            {
                Marshal.Release(trueCond);
                trueCond = IntPtr.Zero;
            }
            if (rootElement != null && Marshal.IsComObject(rootElement))
            {
                Marshal.ReleaseComObject(rootElement);
            }
            if (uia != null && Marshal.IsComObject(uia))
            {
                Marshal.ReleaseComObject(uia);
            }
        }
    }

    private static UiElementInfo? ExtractElementInfo(IUIAutomationElement element, string fallbackId)
    {
        try
        {
            string name = string.Empty;
            if (element.GetCurrentPropertyValue(UIA_NamePropertyId, out var nameObj) == 0 && nameObj is string sName)
            {
                name = sName;
            }

            string automationId = fallbackId;
            if (element.GetCurrentPropertyValue(UIA_AutomationIdPropertyId, out var autoIdObj) == 0 && autoIdObj is string sAutoId && !string.IsNullOrWhiteSpace(sAutoId))
            {
                automationId = sAutoId;
            }

            string className = string.Empty;
            if (element.GetCurrentPropertyValue(UIA_ClassNamePropertyId, out var classObj) == 0 && classObj is string sClass)
            {
                className = sClass;
            }

            string controlType = "Unknown";
            if (element.GetCurrentPropertyValue(UIA_ControlTypePropertyId, out var typeObj) == 0 && typeObj is int iType)
            {
                controlType = MapControlTypeIdToString(iType);
            }

            int x = 0, y = 0, width = 0, height = 0;
            if (element.GetCurrentPropertyValue(UIA_BoundingRectanglePropertyId, out var rectObj) == 0 && rectObj is double[] rectArr && rectArr.Length == 4)
            {
                x = (int)Math.Round(rectArr[0]);
                y = (int)Math.Round(rectArr[1]);
                width = (int)Math.Round(rectArr[2]);
                height = (int)Math.Round(rectArr[3]);
            }

            bool isEnabled = true;
            if (element.GetCurrentPropertyValue(UIA_IsEnabledPropertyId, out var enabledObj) == 0 && enabledObj is bool bEnabled)
            {
                isEnabled = bEnabled;
            }

            bool isFocusable = false;
            if (element.GetCurrentPropertyValue(UIA_IsKeyboardFocusablePropertyId, out var focusObj) == 0 && focusObj is bool bFocus)
            {
                isFocusable = bFocus;
            }

            return new UiElementInfo
            {
                StableId = automationId,
                Name = name,
                ControlType = controlType,
                ClassName = className,
                X = x,
                Y = y,
                Width = width,
                Height = height,
                IsEnabled = isEnabled,
                IsKeyboardFocusable = isFocusable
            };
        }
        catch
        {
            return null;
        }
    }

    private static string MapControlTypeIdToString(int controlTypeId)
    {
        return controlTypeId switch
        {
            50000 => "Button",
            50001 => "Calendar",
            50002 => "CheckBox",
            50003 => "ComboBox",
            50004 => "Edit",
            50005 => "Hyperlink",
            50006 => "Image",
            50007 => "ListItem",
            50008 => "List",
            50009 => "Menu",
            50010 => "MenuBar",
            50011 => "MenuItem",
            50012 => "ProgressBar",
            50013 => "RadioButton",
            50014 => "ScrollBar",
            50015 => "Slider",
            50016 => "Spinner",
            50017 => "StatusBar",
            50018 => "Tab",
            50019 => "TabItem",
            50020 => "Text",
            50021 => "ToolBar",
            50022 => "ToolTip",
            50023 => "Tree",
            50024 => "TreeItem",
            50025 => "Custom",
            50026 => "Group",
            50027 => "Thumb",
            50028 => "DataGrid",
            50029 => "DataItem",
            50030 => "Document",
            50031 => "SplitButton",
            50032 => "Window",
            50033 => "Pane",
            50034 => "Header",
            50035 => "HeaderItem",
            50036 => "Table",
            50037 => "TitleBar",
            50038 => "Separator",
            _ => $"Control_{controlTypeId}"
        };
    }

    #region Win32 Native Fallback Inspection

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static IReadOnlyList<UiElementInfo> InspectWin32ControlsFallback(IntPtr hwnd, int maxElements = 100)
    {
        var list = new List<UiElementInfo>();
        var titleSb = new System.Text.StringBuilder(256);
        var classSb = new System.Text.StringBuilder(256);

        EnumChildWindows(hwnd, (childHwnd, lParam) =>
        {
            if (list.Count >= maxElements) return false;
            if (!IsWindowVisible(childHwnd)) return true;

            titleSb.Clear();
            GetWindowText(childHwnd, titleSb, 256);

            classSb.Clear();
            GetClassName(childHwnd, classSb, 256);

            GetWindowRect(childHwnd, out var rect);
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;

            if (width > 0 && height > 0)
            {
                string className = classSb.ToString();
                string controlType = ClassNameToControlType(className);

                list.Add(new UiElementInfo
                {
                    StableId = $"win32_{childHwnd.ToInt64():X}",
                    Name = titleSb.ToString(),
                    ControlType = controlType,
                    ClassName = className,
                    X = rect.Left,
                    Y = rect.Top,
                    Width = width,
                    Height = height,
                    IsEnabled = IsWindowEnabled(childHwnd),
                    IsKeyboardFocusable = true
                });
            }

            return true;
        }, IntPtr.Zero);

        return list;
    }

    private static string ClassNameToControlType(string className)
    {
        return className.ToLowerInvariant() switch
        {
            "button" => "Button",
            "edit" => "Edit",
            "static" => "Text",
            "combobox" => "ComboBox",
            "listbox" => "List",
            "scrollbar" => "ScrollBar",
            _ => className
        };
    }

    #endregion

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _workQueue.CompleteAdding();
        if (_workerThread.IsAlive)
        {
            _workerThread.Join(500);
        }
        // Only dispose the queue once its worker has exited; a worker still inside a slow inspection ends by itself when
        // it sees the completed queue (disposing it under the worker was the crash described in WorkerLoop).
        if (!_workerThread.IsAlive) _workQueue.Dispose();
    }
}
