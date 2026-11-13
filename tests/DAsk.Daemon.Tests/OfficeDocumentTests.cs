using System.IO.Compression;
using System.Security;
using System.Text;
using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Office;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace DAsk.Daemon.Tests;

/// <summary>
/// office.create_word_document / office.create_excel_workbook: approval of the exact file and content, consumed once, write-ahead audit,
/// and success ONLY when the saved file, read back independently of Office (Open XML), holds exactly what was approved. The fake "Office"
/// writes real minimal .docx/.xlsx packages (optionally wrong), so the read-back check is exercised on real files.
/// Real Word and Excel: <see cref="OfficeDocumentLiveTests"/> (DASK_LIVE_APPS=1).
/// </summary>
[Collection("AgentHost")]
public class OfficeDocumentTests
{
    private const string Owner = "hud-session-owner";

    internal sealed class FakeOffice : IOfficeAutomation
    {
        public int Calls;
        public Func<IReadOnlyList<string>, IReadOnlyList<string>>? Tamper;
        public bool BoldHeading = true;
        /// <summary>Throw AFTER writing (as Excel did offline with a OneDrive-redirected Documents folder), or before writing anything.</summary>
        public Exception? ThrowAfterWrite, ThrowBeforeWrite;
        public void CreateWordDocument(string path, IReadOnlyList<string> paragraphs, bool headingFirst)
        {
            Calls++;
            if (ThrowBeforeWrite != null) throw ThrowBeforeWrite;
            var ps = Tamper?.Invoke(paragraphs) ?? paragraphs;
            var body = string.Concat(ps.Select((p, i) =>
                $"<w:p><w:r>{(headingFirst && i == 0 && BoldHeading ? "<w:rPr><w:b/></w:rPr>" : "")}<w:t xml:space=\"preserve\">{SecurityElement.Escape(p)}</w:t></w:r></w:p>"));
            Zip(path, ("word/document.xml", $"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"));
            if (ThrowAfterWrite != null) throw ThrowAfterWrite;
        }
        public void CreateExcelWorkbook(string path, IReadOnlyList<IReadOnlyList<string>> rows)
        {
            Calls++;
            var shared = rows.SelectMany(r => r).Distinct().ToList();
            string Cell(int r, int c, string v) => double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out _)
                ? $"<c r=\"{(char)('A' + c)}{r + 1}\"{(r == 0 && BoldHeading ? " s=\"1\"" : "")}><v>{v}</v></c>"
                : $"<c r=\"{(char)('A' + c)}{r + 1}\" t=\"s\"{(r == 0 && BoldHeading ? " s=\"1\"" : "")}><v>{shared.IndexOf(v)}</v></c>";
            var data = string.Concat(rows.Select((row, r) => $"<row r=\"{r + 1}\">{string.Concat(row.Select((v, c) => Cell(r, c, v)))}</row>"));
            const string ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
            Zip(path,
                ("xl/worksheets/sheet1.xml", $"<worksheet xmlns=\"{ns}\"><sheetData>{data}</sheetData></worksheet>"),
                ("xl/sharedStrings.xml", $"<sst xmlns=\"{ns}\">{string.Concat(shared.Select(s => $"<si><t>{SecurityElement.Escape(s)}</t></si>"))}</sst>"),
                ("xl/styles.xml", $"<styleSheet xmlns=\"{ns}\"><fonts><font/><font><b/></font></fonts><cellXfs><xf fontId=\"0\"/><xf fontId=\"1\"/></cellXfs></styleSheet>"));
        }
        private static void Zip(string path, params (string Name, string Xml)[] entries)
        {
            using var z = ZipFile.Open(path, ZipArchiveMode.Create);
            foreach (var (n, x) in entries) using (var w = new StreamWriter(z.CreateEntry(n).Open(), new UTF8Encoding(false))) w.Write(x);
        }
    }

    private sealed class Rig : IDisposable
    {
        public readonly ActionPolicyEngine Policy;
        public readonly OfficeDocumentService Service;
        public readonly SqliteEvidenceRecorder Recorder;
        public readonly FakeOffice Office = new();
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly string Folder = Path.Combine(Path.GetTempPath(), $"dask-docs-{Guid.NewGuid():N}");
        public bool Stopped;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-office-{Guid.NewGuid():N}.db");
        public Rig()
        {
            Directory.CreateDirectory(Folder);
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            Service = new OfficeDocumentService(Policy, () => Stopped, () => 1, Recorder, s => s == Owner,
                new OfficeDocumentOptions { Enabled = true, Folder = Folder, Office = Office, ApprovalTtl = TimeSpan.FromSeconds(10) });
        }
        public async Task<(DesktopCallResult Res, ActionApprovalRequest? Card)> Run(string tool, object args, bool approve = true, Action? afterApproval = null)
        {
            lock (Delivered) Delivered.Clear();
            var call = Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), default);
            ActionApprovalRequest? card = null;
            for (int i = 0; i < 500 && card == null && !call.IsCompleted; i++) { lock (Delivered) card = Delivered.LastOrDefault(); await Task.Delay(10); }
            lock (Delivered) card ??= Delivered.LastOrDefault();
            if (card != null)
            {
                afterApproval?.Invoke();
                Policy.SubmitApprovalDecision(new ActionApprovalResponse
                {
                    ApprovalId = card.ApprovalId, ActionId = card.ActionId, ActionType = card.ActionType, ParametersSha256 = card.ParametersSha256,
                    ActionDigest = card.ActionDigest, Approved = approve, DecisionSource = "UserExplicitConfirmation",
                }, Owner, () => false, () => 1);
            }
            return (await call, card);
        }
        public async Task<List<string>> Events() => (await Recorder.GetSafetyAuditRecordsAsync(100)).Select(e => e.EventType).Reverse().ToList();
        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } try { Directory.Delete(Folder, true); } catch { } }
    }

    private static readonly object Doc = new { name = "Quarterly note", heading = true, paragraphs = new[] { "Quarterly note", "D-ASK wrote this paragraph after your approval." } };
    private static readonly object Book = new { name = "Budget", rows = new object[] { new[] { "Item", "Cost" }, new object[] { "Laptop", 1200 }, new object[] { "Mouse", "25.5" } } };

    [Fact]
    public async Task Word_ApprovedExactContent_SavedInDocuments_AndVerifiedFromTheFile()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, card) = await rig.Run(OfficeDocumentService.CreateWord, Doc);
        Assert.Equal("ok", res.Status);
        Assert.Equal(Path.Combine(rig.Folder, "Quarterly note.docx"), card!.ActionParameters["file"]);
        Assert.Equal("[heading, bold] Quarterly note\nD-ASK wrote this paragraph after your approval.", card.ActionParameters["content"]);
        Assert.True(File.Exists(Path.Combine(rig.Folder, "Quarterly note.docx")));
        var ev = await rig.Events();
        Assert.True(ev.IndexOf("OfficeCreateAdmitted") < ev.IndexOf("OfficeCreatePerformed"), string.Join(",", ev));
    }

    [Fact]
    public async Task Excel_ApprovedRows_SavedAndVerified_NumbersCompareAsNumbers()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var (res, card) = await rig.Run(OfficeDocumentService.CreateExcel, Book);
        Assert.Equal("ok", res.Status);
        Assert.Equal("[header, bold] Item | Cost\nLaptop | 1200\nMouse | 25.5", card!.ActionParameters["content"]);
    }

    [Fact]
    public async Task WrongSavedContent_IsReportedUnverified_NeverSuccess()
    {
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Office.Tamper = ps => ps.Select(p => p + "!").ToList();
            Assert.Equal("execution_unverified", (await rig.Run(OfficeDocumentService.CreateWord, Doc)).Res.Error!.Code);
            Assert.Contains("OfficeCreateUnverified", await rig.Events());
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Office.BoldHeading = false;
            var r = (await rig.Run(OfficeDocumentService.CreateWord, Doc)).Res;
            Assert.Equal("execution_unverified", r.Error!.Code);
            Assert.Contains("heading is not bold", r.Error.Message);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Office.BoldHeading = false;
            Assert.Contains("header row is not bold", (await rig.Run(OfficeDocumentService.CreateExcel, Book)).Res.Error!.Message);
        }
    }

    [Fact]
    public async Task OfficeErrorAfterWriting_TheFileIsTheTruth()
    {
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Office.ThrowAfterWrite = new InvalidOperationException("Unable to get the SaveAs property of the Workbook class");
            var res = (await rig.Run(OfficeDocumentService.CreateWord, Doc)).Res;
            Assert.Equal("ok", res.Status);   // the exact approved content is in the file: done, and the error is reported, not hidden
            var r = JsonSerializer.SerializeToElement(res.Result);
            Assert.Contains("SaveAs", r.GetProperty("officeWarning").GetString());
            Assert.Contains("reported an error after writing", r.GetProperty("observed").GetString());
            Assert.Contains("OfficeCreateErrorAfterWrite", await rig.Events());
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Office.ThrowAfterWrite = new InvalidOperationException("boom");
            rig.Office.Tamper = ps => ps.Select(p => p + "?").ToList();
            var res = (await rig.Run(OfficeDocumentService.CreateWord, Doc)).Res;
            Assert.Equal("execution_unverified", res.Error!.Code);   // a written file that does not match is never success
            Assert.Contains("boom", res.Error.Message);
            Assert.Contains(rig.Folder, res.Error.Message);           // and the user is told where it is
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            rig.Office.ThrowBeforeWrite = new InvalidOperationException("Word is not installed");
            var res = (await rig.Run(OfficeDocumentService.CreateWord, Doc)).Res;
            Assert.Equal("office_failed", res.Error!.Code);
            Assert.Contains("No file was written", res.Error.Message);
        }
    }

    [Fact]
    public async Task Denied_Stopped_ExistingFile_NothingIsWritten()
    {
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            Assert.Equal("approval_denied", (await rig.Run(OfficeDocumentService.CreateWord, Doc, approve: false)).Res.Error!.Code);
            Assert.Equal(0, rig.Office.Calls);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            Assert.Equal("emergency_stopped", (await rig.Run(OfficeDocumentService.CreateWord, Doc, afterApproval: () => rig.Stopped = true)).Res.Error!.Code);
            Assert.Equal(0, rig.Office.Calls);
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            File.WriteAllText(Path.Combine(rig.Folder, "Quarterly note.docx"), "user's own file");
            var (res, card) = await rig.Run(OfficeDocumentService.CreateWord, Doc);
            Assert.Equal("file_exists", res.Error!.Code);
            Assert.Null(card);
            Assert.Equal("user's own file", File.ReadAllText(Path.Combine(rig.Folder, "Quarterly note.docx")));
        }
        using (var rig = new Rig())
        {
            await rig.Recorder.InitializeAsync();
            // The file appears between approval and writing: still never overwritten.
            var (res, _) = await rig.Run(OfficeDocumentService.CreateWord, Doc, afterApproval: () => File.WriteAllText(Path.Combine(rig.Folder, "Quarterly note.docx"), "x"));
            Assert.Equal("file_exists", res.Error!.Code);
            Assert.Equal(0, rig.Office.Calls);
        }
    }

    [Theory]
    [InlineData("{\"name\":\"..\\\\evil\",\"paragraphs\":[\"x\"]}")]
    [InlineData("{\"name\":\"C:\\\\x\",\"paragraphs\":[\"x\"]}")]
    [InlineData("{\"name\":\"a/b\",\"paragraphs\":[\"x\"]}")]
    [InlineData("{\"name\":\"ok\",\"paragraphs\":[]}")]
    [InlineData("{\"name\":\"ok\",\"paragraphs\":[\"x\"],\"path\":\"C:\\\\\"}")]
    [InlineData("{\"name\":\"ok\",\"paragraphs\":[\"bad\\u0007bell\"]}")]
    public async Task PathsUnknownFieldsAndBadContent_AreRefusedBeforeAnythingIsAsked(string json)
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Service.ExecuteAsync(OfficeDocumentService.CreateWord, JsonDocument.Parse(json).RootElement, new DesktopActionContext("t1", "c1", Owner), default);
        Assert.Equal("invalid_args", res.Error!.Code);
        Assert.Empty(rig.Delivered);
        Assert.Equal(0, rig.Office.Calls);
    }

    [Fact]
    public async Task ExcelFormulas_AreNeverWritten()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var res = await rig.Service.ExecuteAsync(OfficeDocumentService.CreateExcel,
            JsonSerializer.SerializeToElement(new { name = "x", rows = new[] { new[] { "=cmd|' /C calc'!A0" } } }), new DesktopActionContext("t1", "c1", Owner), default);
        Assert.Equal("invalid_args", res.Error!.Code);
    }

    [Fact]
    public void Policy_OfficeCreation_IsElevated() =>
        Assert.False(new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance).EvaluatePolicy(DesktopActionTypes.OfficeCreateDocument, new(), "WINWORD.EXE").isAllowed);
}

/// <summary>REAL Microsoft Word and Excel: a document and a workbook are created in the user's Documents folder and read back.</summary>
[Trait("Category", "UniversalAppsLive")]
[Collection("UniversalAppsLive")]   // never in parallel with the app-launch live test (it opens a visible Excel of its own)
public class OfficeDocumentLiveTests
{
    private readonly ITestOutputHelper _out;
    public OfficeDocumentLiveTests(ITestOutputHelper o) => _out = o;

    /// <summary>Office AUTOMATION instances (started for COM with -Embedding / /automation): what D-ASK starts, never a user's Office window.</summary>
    private static List<(string Name, int Pid)> AutomationInstances()
    {
        // WMI through its built-in COM scripting interface (no extra package).
        var list = new List<(string, int)>();
        dynamic locator = Activator.CreateInstance(Type.GetTypeFromProgID("WbemScripting.SWbemLocator")!)!;
        dynamic wmi = locator.ConnectServer(".", "root\\cimv2");
        foreach (dynamic o in wmi.ExecQuery("SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE Name='WINWORD.EXE' OR Name='EXCEL.EXE'"))
        {
            string cmd = (o.CommandLine as string) ?? "";
            if (cmd.Contains("-Embedding", StringComparison.OrdinalIgnoreCase) || cmd.Contains("/automation", StringComparison.OrdinalIgnoreCase))
                list.Add(((string)o.Name, (int)o.ProcessId));
        }
        return list;
    }

    [SkippableLiveFact]
    public async Task Live_WordAndExcel_CreateSaveAndVerify()
    {
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        string outDir = Path.Combine(root, "results", "universal-control", "office-" + stamp);
        Directory.CreateDirectory(outDir);
        var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, Path.Combine(outDir, "audit.db"));
        await recorder.InitializeAsync();
        var policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, recorder);
        policy.SetSessionLivenessGate(_ => true);
        policy.ApprovalRequested += (_, r) => Task.Run(async () =>
        {
            await Task.Delay(150);
            policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = r.ActionDigest, Approved = true, DecisionSource = "UserExplicitConfirmation",
            }, "live", () => false, () => 1);
        });
        var service = new OfficeDocumentService(policy, () => false, () => 1, recorder, _ => true, new OfficeDocumentOptions { Enabled = true });
        var before = AutomationInstances().Select(x => x.Pid).ToHashSet();

        var word = await service.ExecuteAsync(OfficeDocumentService.CreateWord, JsonSerializer.SerializeToElement(new
        {
            name = $"D-ASK acceptance {stamp}", heading = true,
            paragraphs = new[] { "D-ASK acceptance document", "This paragraph was written by D-ASK through Microsoft Word after explicit approval, then saved to the Documents folder and read back from the file." },
        }), new DesktopActionContext("w", "c1", "live"), CancellationToken.None);
        var excel = await service.ExecuteAsync(OfficeDocumentService.CreateExcel, JsonSerializer.SerializeToElement(new
        {
            name = $"D-ASK acceptance {stamp}",
            rows = new object[] { new[] { "Item", "Quantity", "Price" }, new object[] { "Notebook", 3, 2.5 }, new object[] { "Pen", 10, 0.75 } },
        }), new DesktopActionContext("x", "c2", "live"), CancellationToken.None);

        await Task.Delay(1500);
        var leftover = AutomationInstances().Where(x => !before.Contains(x.Pid)).Select(x => $"{x.Name} {x.Pid}").ToList();
        var evidence = new
        {
            word = new { request = "Create a document and write this paragraph. Save it to my Documents folder.", capability = OfficeDocumentService.CreateWord, word.Status, word.Error, word.Result },
            excel = new { request = "Create an Excel workbook and populate it.", capability = OfficeDocumentService.CreateExcel, excel.Status, excel.Error, excel.Result },
            officeProcessesLeftBehind = leftover,
        };
        File.WriteAllText(Path.Combine(outDir, "office.json"), JsonSerializer.Serialize(evidence, new JsonSerializerOptions { WriteIndented = true }));
        _out.WriteLine(JsonSerializer.Serialize(evidence));
        SqliteConnection.ClearAllPools();
        Assert.True(word.Status == "ok", word.Error?.Message);
        Assert.True(excel.Status == "ok", excel.Error?.Message);
        Assert.Empty(leftover);
    }
}
