using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Office;

/// <summary>What the Office adapter asks Office to do. Abstracted so the decision logic is testable without Office.</summary>
public interface IOfficeAutomation
{
    /// <summary>Word: a new document with these paragraphs (the first optionally a bold heading), saved as .docx at <paramref name="path"/>.</summary>
    void CreateWordDocument(string path, IReadOnlyList<string> paragraphs, bool headingFirst);
    /// <summary>Excel: a new workbook with these rows on the first sheet (first row bold header), columns fitted, saved as .xlsx.</summary>
    void CreateExcelWorkbook(string path, IReadOnlyList<IReadOnlyList<string>> rows);
}

/// <summary>
/// Real Office automation through Office's own COM interface (Word.Application / Excel.Application), invisible, on a dedicated STA
/// thread, always closed and quit (no Office process is left behind by D-ASK). Nothing else on the computer is touched.
/// </summary>
public sealed class ComOfficeAutomation : IOfficeAutomation
{
    public void CreateWordDocument(string path, IReadOnlyList<string> paragraphs, bool headingFirst) =>
        Sta(() => { var pid = new int[1]; try { WordWork(path, paragraphs, headingFirst, pid); } finally { EndInstance(pid[0]); } });

    public void CreateExcelWorkbook(string path, IReadOnlyList<IReadOnlyList<string>> rows) =>
        Sta(() => { var pid = new int[1]; try { ExcelWork(path, rows, pid); } finally { EndInstance(pid[0]); } });

    /// <summary>
    /// After the work method returned (so every COM reference it held is out of scope): finalize the references, then wait for the
    /// automation instance D-ASK started to exit. If it does not, end exactly that process: it is invisible and D-ASK's own (its id was
    /// read from the instance D-ASK created), never a user's Office window. Deterministic: no Office process outlives the call.
    /// </summary>
    private static void EndInstance(int pid)
    {
        for (int i = 0; i < 2; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
        if (pid <= 0) return;
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(pid);
            if (!p.WaitForExit(10_000)) { p.Kill(); p.WaitForExit(5_000); }
        }
        catch (ArgumentException) { }   // already gone
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    /// <param name="pidOut">Receives the automation instance's process id as soon as it is known, so it is ended even if the work fails.</param>
    private static void WordWork(string path, IReadOnlyList<string> paragraphs, bool headingFirst, int[] pidOut)
    {
        dynamic? app = null, doc = null; int pid = 0;
        var existing = Existing("WINWORD");
        try
        {
            app = Activator.CreateInstance(Type.GetTypeFromProgID("Word.Application") ?? throw new InvalidOperationException("Microsoft Word is not installed."))!;
            app.Visible = false;
            app.DisplayAlerts = 0;   // wdAlertsNone
            doc = app.Documents.Add();
            try { GetWindowThreadProcessId(new IntPtr((int)doc.ActiveWindow.Hwnd), out uint wp); pid = existing.Contains((int)wp) ? 0 : (int)wp; pidOut[0] = pid; } catch { }
            for (int i = 0; i < paragraphs.Count; i++)
            {
                dynamic range = doc.Content;
                range.InsertParagraphAfter();
                dynamic p = doc.Paragraphs[doc.Paragraphs.Count];
                p.Range.Text = paragraphs[i];
                p.Range.Font.Bold = headingFirst && i == 0 ? 1 : 0;
                p.Range.Font.Size = headingFirst && i == 0 ? 16 : 11;
            }
            // The empty first paragraph Documents.Add() starts with.
            if (doc.Paragraphs.Count > paragraphs.Count) doc.Paragraphs[1].Range.Delete();
            doc.SaveAs2(path, 16 /* wdFormatDocumentDefault (.docx) */);
        }
        finally
        {
            try { doc?.Close(0 /* wdDoNotSaveChanges */); } catch { }
            try { app?.Quit(0); } catch { }
            if (doc != null) Marshal.FinalReleaseComObject(doc);
            if (app != null) Marshal.FinalReleaseComObject(app);
        }
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void ExcelWork(string path, IReadOnlyList<IReadOnlyList<string>> rows, int[] pidOut)
    {
        dynamic? app = null, wb = null; int pid = 0;
        var existing = Existing("EXCEL");
        try
        {
            app = Activator.CreateInstance(Type.GetTypeFromProgID("Excel.Application") ?? throw new InvalidOperationException("Microsoft Excel is not installed."))!;
            try { GetWindowThreadProcessId(new IntPtr((int)app.Hwnd), out uint xp); pid = existing.Contains((int)xp) ? 0 : (int)xp; pidOut[0] = pid; } catch { }
            app.Visible = false;
            app.DisplayAlerts = false;
            wb = app.Workbooks.Add();
            dynamic ws = wb.Worksheets[1];
            for (int r = 0; r < rows.Count; r++)
                for (int c = 0; c < rows[r].Count; c++)
                    ws.Cells[r + 1, c + 1].Value2 = rows[r][c];
            ws.Rows[1].Font.Bold = true;
            ws.Columns.AutoFit();
            wb.SaveAs(path, 51 /* xlOpenXMLWorkbook (.xlsx) */);
        }
        finally
        {
            try { wb?.Close(false); } catch { }
            try { app?.Quit(); } catch { }
            if (wb != null) Marshal.FinalReleaseComObject(wb);
            if (app != null) Marshal.FinalReleaseComObject(app);
        }
    }

    /// <summary>Office processes that were running before D-ASK's call: never ended by D-ASK (they may be the user's).</summary>
    private static HashSet<int> Existing(string name) => System.Diagnostics.Process.GetProcessesByName(name).Select(p => { using (p) return p.Id; }).ToHashSet();

    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    /// <summary>Office automation needs a single-threaded apartment.</summary>
    private static void Sta(Action work)
    {
        Exception? error = null;
        var t = new Thread(() => { try { work(); } catch (Exception ex) { error = ex; } }) { IsBackground = true };
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        if (!t.Join(TimeSpan.FromMinutes(2))) throw new TimeoutException("Office did not finish within 2 minutes.");
        if (error != null) throw error is System.Reflection.TargetInvocationException { InnerException: { } inner } ? inner : error;
    }
}

/// <summary>Reads a saved .docx / .xlsx package directly (Open XML), independently of Office: the postcondition check.</summary>
public static class OpenXmlCheck
{
    private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static readonly XNamespace S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

    /// <summary>The document's paragraphs (text) and whether each is bold throughout.</summary>
    public static List<(string Text, bool Bold)> WordParagraphs(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var entry = zip.GetEntry("word/document.xml") ?? throw new InvalidDataException("not a Word document");
        using var s = entry.Open();
        var doc = XDocument.Load(s);
        var list = new List<(string, bool)>();
        foreach (var p in doc.Descendants(W + "p"))
        {
            var runs = p.Descendants(W + "r").Where(r => r.Elements(W + "t").Any()).ToList();
            string text = string.Concat(runs.SelectMany(r => r.Elements(W + "t")).Select(t => t.Value));
            if (text.Length == 0) continue;
            bool bold = runs.All(r => r.Element(W + "rPr")?.Element(W + "b") is { } b && (string?)b.Attribute(W + "val") is null or "1" or "true");
            list.Add((text, bold));
        }
        return list;
    }

    /// <summary>The first sheet as text cells (shared strings resolved; numbers as Excel stores them) and whether row 1 is bold.</summary>
    public static (List<List<string>> Rows, bool HeaderBold) ExcelFirstSheet(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var shared = new List<string>();
        if (zip.GetEntry("xl/sharedStrings.xml") is { } ss)
        {
            using var s = ss.Open();
            shared = XDocument.Load(s).Root!.Elements(S + "si").Select(si => string.Concat(si.Descendants(S + "t").Select(t => t.Value))).ToList();
        }
        var sheetEntry = zip.GetEntry("xl/worksheets/sheet1.xml") ?? throw new InvalidDataException("no first sheet");
        XDocument sheet; using (var s = sheetEntry.Open()) sheet = XDocument.Load(s);
        var boldStyles = BoldStyleIndexes(zip);
        var rows = new List<List<string>>(); bool headerBold = true;
        foreach (var row in sheet.Descendants(S + "row"))
        {
            var cells = new List<string>();
            foreach (var c in row.Elements(S + "c"))
            {
                string col = Regex.Match((string?)c.Attribute("r") ?? "A", "^[A-Z]+").Value;
                int idx = col.Aggregate(0, (a, ch) => a * 26 + (ch - 'A' + 1)) - 1;
                while (cells.Count < idx) cells.Add("");
                string v = c.Element(S + "v")?.Value ?? c.Descendants(S + "t").FirstOrDefault()?.Value ?? "";
                if ((string?)c.Attribute("t") == "s" && int.TryParse(v, out int si) && si < shared.Count) v = shared[si];
                cells.Add(v);
                if (rows.Count == 0 && !boldStyles.Contains((int?)c.Attribute("s") ?? 0)) headerBold = false;
            }
            rows.Add(cells);
        }
        return (rows, headerBold);
    }

    private static HashSet<int> BoldStyleIndexes(ZipArchive zip)
    {
        var result = new HashSet<int>();
        if (zip.GetEntry("xl/styles.xml") is not { } e) return result;
        XDocument st; using (var s = e.Open()) st = XDocument.Load(s);
        var fonts = st.Root!.Element(S + "fonts")?.Elements(S + "font").Select(f => f.Element(S + "b") != null).ToList() ?? new();
        var xfs = st.Root!.Element(S + "cellXfs")?.Elements(S + "xf").ToList() ?? new();
        for (int i = 0; i < xfs.Count; i++)
            if (int.TryParse((string?)xfs[i].Attribute("fontId"), out int fid) && fid < fonts.Count && fonts[fid]) result.Add(i);
        return result;
    }

    /// <summary>Excel stores "100" as the number 100 and "2.50" as 2.5: compare as numbers when both are numbers.</summary>
    public static bool SameCell(string expected, string actual) =>
        expected == actual ||
        (double.TryParse(expected, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var a) &&
         double.TryParse(actual, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var b) && Math.Abs(a - b) < 1e-9);
}

public sealed class OfficeDocumentOptions
{
    public bool Enabled { get; init; }
    public TimeSpan ApprovalTtl { get; init; } = TimeSpan.FromSeconds(60);
    /// <summary>Where documents are saved: the user's Documents folder (fixed by the daemon; the agent names only the file).</summary>
    public string Folder { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
    public IOfficeAutomation Office { get; init; } = new ComOfficeAutomation();
}

/// <summary>
/// office.create_word_document / office.create_excel_workbook: a NEW Word document or Excel workbook with exactly the given content, saved
/// in the user's Documents folder under a name the request gives (never overwriting anything). The approval card shows the exact file and
/// every paragraph / cell; the approval is consumed once (same policy engine, digest, owner session, liveness, expiry and Stop generation as
/// every other action); write-ahead audit; Office does the work; then the saved FILE is read back independently (Open XML) and compared
/// with what was approved before success is reported.
/// </summary>
public sealed class OfficeDocumentService : IDesktopActionRequestService
{
    public const string CreateWord = "office.create_word_document";
    public const string CreateExcel = "office.create_excel_workbook";
    private const int MaxParagraphs = 50, MaxParagraphChars = 2000, MaxRows = 200, MaxCols = 26, MaxCellChars = 500;
    private static readonly Regex SafeName = new(@"^[\p{L}\p{N}][\p{L}\p{N} _().,'&-]{0,79}$");

    private readonly ActionPolicyEngine _policy;
    private readonly Func<bool> _isStopped;
    private readonly Func<ulong> _generation;
    private readonly IEvidenceRecorder? _evidence;
    private readonly Func<string, bool>? _isSessionLive;
    private readonly OfficeDocumentOptions _opts;
    private readonly ILogger? _logger;

    public OfficeDocumentService(ActionPolicyEngine policy, Func<bool> isStopped, Func<ulong> generation, IEvidenceRecorder? evidence,
        Func<string, bool>? isSessionLive, OfficeDocumentOptions options, ILogger? logger = null)
    {
        _policy = policy; _isStopped = isStopped; _generation = generation; _evidence = evidence; _isSessionLive = isSessionLive; _opts = options; _logger = logger;
    }

    public IReadOnlyList<string> Tools => _opts.Enabled && _evidence != null && _isSessionLive != null ? new[] { CreateWord, CreateExcel } : Array.Empty<string>();
    public int MaxCallMs => (int)Math.Min(_opts.ApprovalTtl.TotalMilliseconds, ActionPolicyEngine.MaxApprovalTtl.TotalMilliseconds) + 150_000;

    /// <summary>Pure: { name, paragraphs[], heading? } for Word; { name, rows[][] } for Excel. Nothing unknown, nothing unbounded.</summary>
    public static string? Parse(string tool, JsonElement args, out string name, out List<string> paragraphs, out bool heading, out List<List<string>> rows)
    {
        name = ""; paragraphs = new(); heading = false; rows = new();
        if (args.ValueKind != JsonValueKind.Object) return "arguments must be an object";
        foreach (var p in args.EnumerateObject())
        {
            switch (p.Name)
            {
                case "name" when p.Value.ValueKind == JsonValueKind.String: name = p.Value.GetString()!.Trim(); break;
                case "heading" when tool == CreateWord && p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False: heading = p.Value.GetBoolean(); break;
                case "paragraphs" when tool == CreateWord && p.Value.ValueKind == JsonValueKind.Array:
                    foreach (var e in p.Value.EnumerateArray())
                    {
                        if (e.ValueKind != JsonValueKind.String) return "paragraphs must be text";
                        paragraphs.Add(e.GetString()!);
                    }
                    break;
                case "rows" when tool == CreateExcel && p.Value.ValueKind == JsonValueKind.Array:
                    foreach (var r in p.Value.EnumerateArray())
                    {
                        if (r.ValueKind != JsonValueKind.Array) return "rows must be lists of cells";
                        var row = new List<string>();
                        foreach (var c in r.EnumerateArray())
                        {
                            if (c.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)) return "cells must be text or numbers";
                            row.Add(c.ValueKind == JsonValueKind.Number ? c.GetRawText() : c.GetString()!);
                        }
                        rows.Add(row);
                    }
                    break;
                default: return $"unknown or malformed argument '{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}'";
            }
        }
        if (!SafeName.IsMatch(name) || name.EndsWith('.')) return "name must be a plain file name (letters, digits, spaces and simple punctuation; no folders or extension)";
        if (tool == CreateWord)
        {
            if (paragraphs.Count is 0 or > MaxParagraphs) return $"between 1 and {MaxParagraphs} paragraphs";
            if (paragraphs.Any(x => x.Trim().Length == 0 || x.Length > MaxParagraphChars || x.Any(ch => char.IsControl(ch)))) return $"each paragraph must be 1-{MaxParagraphChars} characters of plain text";
        }
        else
        {
            if (rows.Count is 0 or > MaxRows || rows.Any(r => r.Count is 0 or > MaxCols)) return $"between 1 and {MaxRows} rows of 1 to {MaxCols} cells";
            if (rows.SelectMany(r => r).Any(c => c.Length > MaxCellChars || c.Any(char.IsControl) || c.StartsWith('='))) return $"cells are plain values of at most {MaxCellChars} characters (formulas are not written)";
        }
        return null;
    }

    public async Task<DesktopCallResult> ExecuteAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        try { return await RunAsync(tool, args, ctx, ct); }
        catch (OperationCanceledException) { return DesktopCallResult.Cancelled(); }
    }

    private async Task<DesktopCallResult> RunAsync(string tool, JsonElement args, DesktopActionContext ctx, CancellationToken ct)
    {
        if (tool != CreateWord && tool != CreateExcel) return DesktopCallResult.Fail("unknown_tool", "This operation is not available.");
        if (Parse(tool, args, out var name, out var paragraphs, out var heading, out var rows) is { } bad) return DesktopCallResult.Fail("invalid_args", bad);
        if (!_opts.Enabled || _evidence == null || _isSessionLive == null) return DesktopCallResult.Fail("office_disabled", "Creating Office documents is switched off in this installation. Nothing was done.");
        if (string.IsNullOrWhiteSpace(ctx.OwnerSessionId)) return DesktopCallResult.Fail("no_owner", "The task has no owning HUD session, so nobody can approve this.");
        if (_isStopped()) return DesktopCallResult.Fail("emergency_stopped", "Emergency Stop is active; no action can be requested.");

        bool word = tool == CreateWord;
        string folder = Path.GetFullPath(_opts.Folder);
        string path = Path.GetFullPath(Path.Combine(folder, name + (word ? ".docx" : ".xlsx")));
        if (!string.Equals(Path.GetDirectoryName(path), Path.TrimEndingDirectorySeparator(folder), StringComparison.OrdinalIgnoreCase))
            return DesktopCallResult.Fail("invalid_args", "The file must be directly in your Documents folder.");
        if (File.Exists(path)) return DesktopCallResult.Fail("file_exists", $"{Path.GetFileName(path)} already exists in your Documents folder; D-ASK never overwrites a file. Choose another name.");

        string type = word ? DesktopActionTypes.OfficeCreateDocument : DesktopActionTypes.OfficeCreateWorkbook;
        var (allowed, risk, reason) = _policy.EvaluatePolicy(type, new Dictionary<string, string>(), word ? "WINWORD.EXE" : "EXCEL.EXE");
        if (allowed || risk != ActionRiskLevel.Elevated) return DesktopCallResult.Fail("policy_denied", $"The policy does not permit this request ({reason}).");

        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["operation"] = word ? "Create a Word document" : "Create an Excel workbook",
            ["file"] = path,
            ["content"] = word
                ? string.Join("\n", paragraphs.Select((p, i) => (heading && i == 0 ? "[heading, bold] " : "") + p))
                : string.Join("\n", rows.Select((r, i) => (i == 0 ? "[header, bold] " : "") + string.Join(" | ", r))),
            ["result"] = $"A NEW file {Path.GetFileName(path)} is saved in your Documents folder with exactly this content. No other file is changed; an existing file is never overwritten.",
            ["reversible"] = "Yes: delete the new file.",
            ["execution"] = $"Performed once, right after your approval, by Microsoft {(word ? "Word" : "Excel")} (invisible, closed afterwards); then the saved file is read back and compared with this content before it is reported as done.",
        };
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        var started = new DateTimeOffset(self.StartTime.ToUniversalTime(), TimeSpan.Zero);
        var request = new ActionApprovalRequest
        {
            ApprovalId = Guid.NewGuid().ToString("N"), ActionId = Guid.NewGuid().ToString("N"), ActionType = type, ActionParameters = parameters,
            TargetProcessName = "D-ASK office", TargetWindowTitle = Path.GetFileName(path), TargetHwnd = 0,
            TargetProcessId = self.Id, TargetProcessCreationTime = started, SessionId = ctx.OwnerSessionId, StopGeneration = _generation(),
            RiskLevel = risk.ToString(), CreatedAtUtc = DateTimeOffset.UtcNow, ExpiresAtUtc = DateTimeOffset.UtcNow + _opts.ApprovalTtl,
            Reason = $"D-ASK asks to create {Path.GetFileName(path)}.",
        };
        await AuditAsync("OfficeCreateRequested", request, ctx, path, $"agent call {ctx.CallId}");
        var decision = await _policy.RequestApprovalAsync(request, ct);
        if (ct.IsCancellationRequested) return DesktopCallResult.Cancelled();
        if (!decision.Approved)
        {
            await AuditAsync("OfficeCreateNotApproved", request, ctx, path, decision.DecisionSource ?? "denied");
            return DesktopCallResult.Fail(decision.DecisionSource switch
            {
                "TimeoutDenied" => "approval_expired", "EmergencyStopDenied" or "StaleGenerationDenied" => "emergency_stopped",
                "SessionDisconnectedDenied" => "hud_unavailable", "IntegrityMismatch" => "approval_refused", _ => "approval_denied",
            }, "The request was not approved. Nothing was created.");
        }
        if (_isStopped() || _generation() != request.StopGeneration) return DesktopCallResult.Fail("emergency_stopped", "An Emergency Stop happened after the approval, so it no longer applies. Nothing was created.");
        var (valid, error) = _policy.ValidateConsumedApproval(request.ApprovalId, request.ActionId, request.ActionType, parameters,
            request.TargetProcessName, 0, self.Id, started, ctx.OwnerSessionId, _generation(), _isStopped());
        if (!valid) { await AuditAsync("OfficeCreateApprovalInvalid", request, ctx, path, error ?? "invalid"); return DesktopCallResult.Fail("approval_invalid", "The approval could not be validated. Nothing was created."); }
        if (!_isSessionLive(request.SessionId)) return DesktopCallResult.Fail("hud_unavailable", "The HUD that approved this is no longer live. Nothing was created.");
        if (File.Exists(path)) return DesktopCallResult.Fail("file_exists", $"{Path.GetFileName(path)} appeared after the approval; D-ASK never overwrites a file. Nothing was created.");
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = "OfficeCreateAdmitted", Source = "OfficeDocumentService", ActionId = request.ActionId, ApprovalId = request.ApprovalId, SessionId = request.SessionId,
                RiskLevel = request.RiskLevel, StopGeneration = request.StopGeneration, Decision = "Admitted", Reason = "approval consumed once",
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, callId = ctx.CallId, file = path, type }),
            });
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[Office] Write-ahead audit failed; refusing to act.");
            return DesktopCallResult.Fail("journal_unavailable", "The action could not be recorded before acting, so it was not performed. Nothing was created.");
        }

        string? officeError = null;
        try
        {
            if (word) await Task.Run(() => _opts.Office.CreateWordDocument(path, paragraphs, heading), ct);
            else await Task.Run(() => _opts.Office.CreateExcelWorkbook(path, rows), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Office can raise an error AFTER writing the file (seen offline with a OneDrive-redirected Documents folder, 2026-11-14:
            // Excel saved the exact workbook, then SaveAs failed). The file is the truth: if one exists, it is checked below like any other.
            officeError = ex.Message;
            if (!File.Exists(path))
            {
                await AuditAsync("OfficeCreateFailed", request, ctx, path, ex.GetType().Name);
                return DesktopCallResult.Fail("office_failed", $"Microsoft {(word ? "Word" : "Excel")} could not create the file ({ex.Message}). No file was written.");
            }
            await AuditAsync("OfficeCreateErrorAfterWrite", request, ctx, path, ex.GetType().Name);
        }

        // Postcondition, independently of Office: the saved file exists and holds exactly the approved content.
        string? problem = null;
        try
        {
            if (!File.Exists(path)) problem = "the file was not saved";
            else if (word)
            {
                var got = OpenXmlCheck.WordParagraphs(path);
                if (got.Count != paragraphs.Count) problem = $"{got.Count} paragraphs were saved, {paragraphs.Count} were approved";
                else for (int i = 0; i < got.Count && problem == null; i++)
                {
                    if (got[i].Text != paragraphs[i]) problem = $"paragraph {i + 1} differs";
                    else if (heading && i == 0 && !got[i].Bold) problem = "the heading is not bold";
                }
            }
            else
            {
                var (got, headerBold) = OpenXmlCheck.ExcelFirstSheet(path);
                if (got.Count != rows.Count) problem = $"{got.Count} rows were saved, {rows.Count} were approved";
                else for (int r = 0; r < rows.Count && problem == null; r++)
                    for (int c = 0; c < rows[r].Count && problem == null; c++)
                        if (c >= got[r].Count || !OpenXmlCheck.SameCell(rows[r][c], got[r][c])) problem = $"cell {(char)('A' + c)}{r + 1} differs";
                if (problem == null && !headerBold) problem = "the header row is not bold";
            }
        }
        catch (Exception ex) { problem = $"the saved file could not be read back ({ex.GetType().Name})"; }
        if (problem != null)
        {
            await AuditAsync("OfficeCreateUnverified", request, ctx, path, problem);
            return DesktopCallResult.Fail("execution_unverified", $"{Path.GetFileName(path)} was written ({path}), but the check of the saved file failed: {problem}." +
                (officeError != null ? $" Microsoft {(word ? "Word" : "Excel")} also reported: {officeError}" : ""));
        }
        await AuditAsync("OfficeCreatePerformed", request, ctx, path, officeError == null ? "saved file read back and matches" : $"saved file read back and matches; Office reported after writing: {officeError}");
        string observed = word ? $"{Path.GetFileName(path)} is saved with {paragraphs.Count} paragraph(s){(heading ? ", the first as a bold heading" : "")}, read back from the file"
                               : $"{Path.GetFileName(path)} is saved with {rows.Count} row(s) and a bold header, read back from the file";
        return DesktopCallResult.Ok(new
        {
            created = true, verified = true, executed = true, file = path, bytes = new FileInfo(path).Length,
            observed = officeError == null ? observed
                : observed + $" (Microsoft {(word ? "Word" : "Excel")} reported an error after writing it — \"{officeError}\" — but the saved file holds exactly the approved content)",
            officeWarning = officeError,
        });
    }

    private async Task AuditAsync(string evt, ActionApprovalRequest q, DesktopActionContext ctx, string path, string reason)
    {
        if (_evidence == null) return;
        try
        {
            await _evidence.RecordSafetyAuditAsync(new SafetyAuditRecord
            {
                EventType = evt, Source = "OfficeDocumentService", ActionId = q.ActionId, ApprovalId = q.ApprovalId, SessionId = q.SessionId,
                RiskLevel = q.RiskLevel, StopGeneration = q.StopGeneration, Decision = evt, Reason = AuditJson.Bound(reason),
                DetailsJson = AuditJson.Details(new { taskId = ctx.TaskId, callId = ctx.CallId, file = path, type = q.ActionType }),
            });
        }
        catch (Exception ex) { _logger?.LogWarning(ex, "[Office] Audit record {Event} failed.", evt); }
    }
}
