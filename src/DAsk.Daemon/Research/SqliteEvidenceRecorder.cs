using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Research;

public class SqliteEvidenceRecorder : IEvidenceRecorder
{
    private readonly ILogger<SqliteEvidenceRecorder> _logger;
    private readonly string _connectionString;
    private readonly SemaphoreSlim _dbLock = new(1, 1);
    private bool _initialized = false;

    public SqliteEvidenceRecorder(ILogger<SqliteEvidenceRecorder> logger, string dbPath = ".d-ask-memory.db")
    {
        _logger = logger;
        _connectionString = $"Data Source={dbPath};Mode=ReadWriteCreate;Cache=Shared";
        try
        {
            SQLitePCL.Batteries.Init();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "SQLitePCL.Batteries.Init() already initialized or failed.");
        }
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        if (_initialized) return;

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            if (_initialized) return;

            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            string createTableSql = @"
                CREATE TABLE IF NOT EXISTS execution_evidence (
                    record_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    action_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    side_effect_risk TEXT NOT NULL,
                    reversibility TEXT NOT NULL,
                    prior_uncertainty REAL NOT NULL,
                    policy_gate_approved INTEGER NOT NULL,
                    execution_status TEXT NOT NULL,
                    execution_duration_ms REAL NOT NULL,
                    verified INTEGER NOT NULL,
                    verification_method TEXT NOT NULL,
                    raw_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_evidence_task_id ON execution_evidence (task_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_action_id ON execution_evidence (action_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_timestamp ON execution_evidence (timestamp);

                CREATE TABLE IF NOT EXISTS safety_audit_trail (
                    event_id TEXT PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    source TEXT NOT NULL,
                    action_id TEXT,
                    approval_id TEXT,
                    session_id TEXT,
                    risk_level TEXT,
                    parameters_sha256 TEXT,
                    stop_generation INTEGER NOT NULL DEFAULT 0,
                    decision TEXT,
                    reason TEXT,
                    details_json TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_safety_timestamp ON safety_audit_trail (timestamp);
                CREATE INDEX IF NOT EXISTS idx_safety_event_type ON safety_audit_trail (event_type);
                CREATE INDEX IF NOT EXISTS idx_safety_action_id ON safety_audit_trail (action_id);

                -- Phase 7B.1a (F5): append-only from here on. Existing rows are not changed; they simply can no longer
                -- be updated or deleted. Records are written with a plain INSERT, so a duplicate id fails loudly
                -- instead of silently replacing evidence.
                CREATE TRIGGER IF NOT EXISTS trg_safety_audit_no_update BEFORE UPDATE ON safety_audit_trail
                BEGIN SELECT RAISE(ABORT, 'safety_audit_trail is append-only'); END;
                CREATE TRIGGER IF NOT EXISTS trg_safety_audit_no_delete BEFORE DELETE ON safety_audit_trail
                BEGIN SELECT RAISE(ABORT, 'safety_audit_trail is append-only'); END;

                -- Hash chain over audit events recorded from this version on (additive; historical rows stay unchained).
                CREATE TABLE IF NOT EXISTS safety_audit_chain (
                    seq INTEGER PRIMARY KEY,
                    event_id TEXT NOT NULL UNIQUE,
                    canonical_event TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    hash TEXT NOT NULL
                );
                CREATE TRIGGER IF NOT EXISTS trg_safety_chain_no_update BEFORE UPDATE ON safety_audit_chain
                BEGIN SELECT RAISE(ABORT, 'safety_audit_chain is append-only'); END;
                CREATE TRIGGER IF NOT EXISTS trg_safety_chain_no_delete BEFORE DELETE ON safety_audit_chain
                BEGIN SELECT RAISE(ABORT, 'safety_audit_chain is append-only'); END;
            ";

            using var cmd = new SqliteCommand(createTableSql, conn);
            await cmd.ExecuteNonQueryAsync(cancellationToken);

            // Safe migration for existing tables created in earlier versions
            string[] migrationSqls = {
                "ALTER TABLE safety_audit_trail ADD COLUMN approval_id TEXT;",
                "ALTER TABLE safety_audit_trail ADD COLUMN session_id TEXT;",
                "ALTER TABLE safety_audit_trail ADD COLUMN stop_generation INTEGER NOT NULL DEFAULT 0;"
            };
            foreach (var migSql in migrationSqls)
            {
                try
                {
                    using var migCmd = new SqliteCommand(migSql, conn);
                    await migCmd.ExecuteNonQueryAsync(cancellationToken);
                }
                catch { /* Ignore duplicate column error if already present */ }
            }

            // Created after the column migration (Phase 7B.1a fix): on a database from before approval_id existed,
            // creating this index first made initialisation fail, and with it every later audit write.
            using (var idx = new SqliteCommand("CREATE INDEX IF NOT EXISTS idx_safety_approval_id ON safety_audit_trail (approval_id);", conn))
                await idx.ExecuteNonQueryAsync(cancellationToken);

            _initialized = true;
            _logger.LogInformation("SqliteEvidenceRecorder initialized successfully.");
        }
        finally
        {
            _dbLock.Release();
        }
    }

    public async Task RecordEvidenceAsync(ExecutionEvidenceRecord record, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);

        string rawJson = record.ToJson();

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            // Plain INSERT (Phase 7B.1a): a duplicate record id is an error, never a silent overwrite of evidence.
            string insertSql = @"
                INSERT INTO execution_evidence (
                    record_id, task_id, action_id, timestamp, agent_name, tool_name,
                    side_effect_risk, reversibility, prior_uncertainty, policy_gate_approved,
                    execution_status, execution_duration_ms, verified, verification_method, raw_json
                ) VALUES (
                    @record_id, @task_id, @action_id, @timestamp, @agent_name, @tool_name,
                    @side_effect_risk, @reversibility, @prior_uncertainty, @policy_gate_approved,
                    @execution_status, @execution_duration_ms, @verified, @verification_method, @raw_json
                );
            ";

            using var cmd = new SqliteCommand(insertSql, conn);
            cmd.Parameters.AddWithValue("@record_id", record.RecordId);
            cmd.Parameters.AddWithValue("@task_id", record.TaskId);
            cmd.Parameters.AddWithValue("@action_id", record.ActionId);
            cmd.Parameters.AddWithValue("@timestamp", record.Timestamp.ToString("o"));
            cmd.Parameters.AddWithValue("@agent_name", record.ActionMetadata.AgentName);
            cmd.Parameters.AddWithValue("@tool_name", record.ActionMetadata.ToolName);
            cmd.Parameters.AddWithValue("@side_effect_risk", record.RiskAssessment.SideEffectRisk);
            cmd.Parameters.AddWithValue("@reversibility", record.RiskAssessment.Reversibility);
            cmd.Parameters.AddWithValue("@prior_uncertainty", record.RiskAssessment.PriorUncertainty);
            cmd.Parameters.AddWithValue("@policy_gate_approved", record.RiskAssessment.PolicyGateApproved ? 1 : 0);
            cmd.Parameters.AddWithValue("@execution_status", record.ExecutionOutcome.Status);
            cmd.Parameters.AddWithValue("@execution_duration_ms", record.ExecutionOutcome.ExecutionDurationMs);
            cmd.Parameters.AddWithValue("@verified", record.VerificationDecision.Verified ? 1 : 0);
            cmd.Parameters.AddWithValue("@verification_method", record.VerificationDecision.VerificationMethod);
            cmd.Parameters.AddWithValue("@raw_json", rawJson);

            await cmd.ExecuteNonQueryAsync(cancellationToken);
            _logger.LogDebug("Recorded execution evidence: RecordId='{RecordId}', TaskId='{TaskId}'", record.RecordId, record.TaskId);
        }
        finally
        {
            _dbLock.Release();
        }
    }

    public async Task<ExecutionEvidenceRecord?> GetEvidenceByIdAsync(string recordId, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            string query = "SELECT raw_json FROM execution_evidence WHERE record_id = @record_id LIMIT 1;";
            using var cmd = new SqliteCommand(query, conn);
            cmd.Parameters.AddWithValue("@record_id", recordId);

            var rawJsonObj = await cmd.ExecuteScalarAsync(cancellationToken);
            if (rawJsonObj is string rawJson)
            {
                return ExecutionEvidenceRecord.FromJson(rawJson);
            }
            return null;
        }
        finally
        {
            _dbLock.Release();
        }
    }

    public async Task<IReadOnlyList<ExecutionEvidenceRecord>> GetEvidenceByTaskIdAsync(string taskId, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);

        var list = new List<ExecutionEvidenceRecord>();

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            string query = "SELECT raw_json FROM execution_evidence WHERE task_id = @task_id ORDER BY timestamp ASC;";
            using var cmd = new SqliteCommand(query, conn);
            cmd.Parameters.AddWithValue("@task_id", taskId);

            using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                string rawJson = reader.GetString(0);
                var record = ExecutionEvidenceRecord.FromJson(rawJson);
                if (record != null)
                {
                    list.Add(record);
                }
            }
            return list;
        }
        finally
        {
            _dbLock.Release();
        }
    }

    // ── Phase 7B.1a (F5): validated, append-only, hash-chained safety audit ────────────────────────────────────────

    public const string ChainDomain = "DASK-AUDIT-CHAIN-V1";

    /// <summary>The <c>prev_hash</c> of the first chained event.</summary>
    public static readonly string ChainGenesis = DAsk.Daemon.Automation.Policy.CanonicalJson.Digest(ChainDomain, "genesis");

    private static readonly System.Text.RegularExpressions.Regex EventTypePattern = new(@"^[A-Za-z0-9_.\-]{1,64}$");

    /// <summary>Returns why a record is malformed, or null. Malformed records are rejected, never "fixed".</summary>
    public static string? ValidateAuditRecord(SafetyAuditRecord r)
    {
        if (string.IsNullOrWhiteSpace(r.EventId) || r.EventId.Length > 128) return "event id missing or too long";
        if (!EventTypePattern.IsMatch(r.EventType ?? string.Empty)) return "event type is not a bounded identifier";
        if (string.IsNullOrWhiteSpace(r.Source) || r.Source.Length > 128) return "source missing or too long";
        if ((r.ActionId?.Length ?? 0) > 128 || (r.ApprovalId?.Length ?? 0) > 128 || (r.SessionId?.Length ?? 0) > 128) return "an id is too long";
        if ((r.RiskLevel?.Length ?? 0) > 32 || (r.ParametersSha256?.Length ?? 0) > 128 || (r.Decision?.Length ?? 0) > 64) return "a field is too long";
        if ((r.Reason?.Length ?? 0) > 2048) return "reason is too long";
        if (r.StopGeneration > long.MaxValue) return "stop generation out of range";
        if (r.DetailsJson != null)
        {
            if (r.DetailsJson.Length > AuditJson.MaxDetailsChars) return "details exceed the size limit";
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(r.DetailsJson);
                if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object) return "details are not a JSON object";
            }
            catch (System.Text.Json.JsonException) { return "details are not valid JSON"; }
        }
        return null;
    }

    /// <summary>The canonical form of an audit row exactly as stored (DASK-CJ-1), which the chain hashes.</summary>
    private static string CanonicalAuditRow(string eventId, string timestamp, string eventType, string source, string? actionId,
        string? approvalId, string? sessionId, string? riskLevel, string? parametersSha256, long stopGeneration,
        string? decision, string? reason, string? detailsJson)
    {
        var node = new System.Text.Json.Nodes.JsonObject
        {
            ["eventId"] = eventId, ["timestamp"] = timestamp, ["eventType"] = eventType, ["source"] = source,
            ["actionId"] = actionId, ["approvalId"] = approvalId, ["sessionId"] = sessionId, ["riskLevel"] = riskLevel,
            ["parametersSha256"] = parametersSha256, ["stopGeneration"] = stopGeneration, ["decision"] = decision,
            ["reason"] = reason, ["detailsJson"] = detailsJson,
        };
        return DAsk.Daemon.Automation.Policy.CanonicalJson.EncodeToString(System.Text.Json.JsonSerializer.SerializeToElement(node));
    }

    private static string ChainHash(string prevHash, long seq, string canonical) =>
        DAsk.Daemon.Automation.Policy.CanonicalJson.Digest(ChainDomain, $"{prevHash}\n{seq}\n{canonical}");

    public async Task RecordSafetyAuditAsync(SafetyAuditRecord record, CancellationToken cancellationToken = default)
    {
        string? invalid = ValidateAuditRecord(record);
        if (invalid != null)
        {
            _logger.LogError("[SafetyAudit] Rejected malformed audit record ({EventType}): {Problem}",
                AuditJson.Bound(record.EventType, 64), invalid);
            throw new ArgumentException($"Malformed safety audit record: {invalid}", nameof(record));
        }

        await InitializeAsync(cancellationToken);

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);
            using var tx = conn.BeginTransaction();

            string timestamp = record.Timestamp.ToString("o");
            string insertSql = @"
                INSERT INTO safety_audit_trail (
                    event_id, timestamp, event_type, source, action_id, approval_id, session_id,
                    risk_level, parameters_sha256, stop_generation, decision, reason, details_json
                ) VALUES (
                    @event_id, @timestamp, @event_type, @source, @action_id, @approval_id, @session_id,
                    @risk_level, @parameters_sha256, @stop_generation, @decision, @reason, @details_json
                );
            ";

            using (var cmd = new SqliteCommand(insertSql, conn, tx))
            {
                cmd.Parameters.AddWithValue("@event_id", record.EventId);
                cmd.Parameters.AddWithValue("@timestamp", timestamp);
                cmd.Parameters.AddWithValue("@event_type", record.EventType);
                cmd.Parameters.AddWithValue("@source", record.Source);
                cmd.Parameters.AddWithValue("@action_id", (object?)record.ActionId ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@approval_id", (object?)record.ApprovalId ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@session_id", (object?)record.SessionId ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@risk_level", (object?)record.RiskLevel ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@parameters_sha256", (object?)record.ParametersSha256 ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@stop_generation", (long)record.StopGeneration);
                cmd.Parameters.AddWithValue("@decision", (object?)record.Decision ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@reason", (object?)record.Reason ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@details_json", (object?)record.DetailsJson ?? DBNull.Value);
                await cmd.ExecuteNonQueryAsync(cancellationToken);
            }

            // Link into the chain: seq is the previous seq + 1 (genesis for the first), in the same transaction.
            long prevSeq = 0;
            string prevHash = ChainGenesis;
            using (var last = new SqliteCommand("SELECT seq, hash FROM safety_audit_chain ORDER BY seq DESC LIMIT 1;", conn, tx))
            using (var reader = await last.ExecuteReaderAsync(cancellationToken))
            {
                if (await reader.ReadAsync(cancellationToken)) { prevSeq = reader.GetInt64(0); prevHash = reader.GetString(1); }
            }
            long seq = prevSeq + 1;
            string canonical = CanonicalAuditRow(record.EventId, timestamp, record.EventType, record.Source, record.ActionId,
                record.ApprovalId, record.SessionId, record.RiskLevel, record.ParametersSha256, (long)record.StopGeneration,
                record.Decision, record.Reason, record.DetailsJson);
            using (var link = new SqliteCommand(
                "INSERT INTO safety_audit_chain (seq, event_id, canonical_event, prev_hash, hash) VALUES (@seq, @id, @c, @p, @h);", conn, tx))
            {
                link.Parameters.AddWithValue("@seq", seq);
                link.Parameters.AddWithValue("@id", record.EventId);
                link.Parameters.AddWithValue("@c", canonical);
                link.Parameters.AddWithValue("@p", prevHash);
                link.Parameters.AddWithValue("@h", ChainHash(prevHash, seq, canonical));
                await link.ExecuteNonQueryAsync(cancellationToken);
            }

            tx.Commit();
            _logger.LogInformation("[SafetyAudit] Persisted safety event: {EventType} from '{Source}', Action={ActionId}, Gen={Gen}, Seq={Seq}",
                record.EventType, record.Source, record.ActionId ?? "none", record.StopGeneration, seq);
        }
        finally
        {
            _dbLock.Release();
        }
    }

    /// <summary>
    /// Verifies the audit hash chain. Checks, in order of <c>seq</c>: sequence numbers start at 1 with no gaps; each
    /// <c>prev_hash</c> equals the previous event's hash (genesis for seq 1); each hash recomputes; and each chained
    /// event's row in <c>safety_audit_trail</c> still exists and canonicalises to the chained text. Reports the first
    /// failure; nothing is repaired or deleted. Rows recorded before the chain existed are counted as unchained.
    /// </summary>
    public async Task<AuditChainVerification> VerifyAuditChainAsync(CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);
        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            long expectedSeq = 1, count = 0;
            string prevHash = ChainGenesis;
            using (var cmd = new SqliteCommand(@"
                SELECT c.seq, c.event_id, c.canonical_event, c.prev_hash, c.hash,
                       t.event_id, t.timestamp, t.event_type, t.source, t.action_id, t.approval_id, t.session_id,
                       t.risk_level, t.parameters_sha256, t.stop_generation, t.decision, t.reason, t.details_json
                FROM safety_audit_chain c LEFT JOIN safety_audit_trail t ON t.event_id = c.event_id
                ORDER BY c.seq ASC;", conn))
            using (var r = await cmd.ExecuteReaderAsync(cancellationToken))
            {
                while (await r.ReadAsync(cancellationToken))
                {
                    long seq = r.GetInt64(0);
                    string canonical = r.GetString(2), storedPrev = r.GetString(3), storedHash = r.GetString(4);
                    if (seq != expectedSeq) return AuditChainVerification.Fail(count, expectedSeq, $"missing record: expected seq {expectedSeq}, found {seq}");
                    if (storedPrev != prevHash) return AuditChainVerification.Fail(count, seq, "previous-hash link broken");
                    if (ChainHash(storedPrev, seq, canonical) != storedHash) return AuditChainVerification.Fail(count, seq, "event hash does not recompute");
                    if (r.IsDBNull(5)) return AuditChainVerification.Fail(count, seq, "audit row for a chained event is missing");
                    string? S(int i) => r.IsDBNull(i) ? null : r.GetString(i);
                    string rowCanonical = CanonicalAuditRow(r.GetString(5), r.GetString(6), r.GetString(7), r.GetString(8), S(9), S(10), S(11),
                        S(12), S(13), r.IsDBNull(14) ? 0 : r.GetInt64(14), S(15), S(16), S(17));
                    if (rowCanonical != canonical) return AuditChainVerification.Fail(count, seq, "audit row differs from the chained event");
                    prevHash = storedHash;
                    expectedSeq++;
                    count++;
                }
            }

            long unchained;
            using (var u = new SqliteCommand("SELECT COUNT(*) FROM safety_audit_trail t WHERE NOT EXISTS (SELECT 1 FROM safety_audit_chain c WHERE c.event_id = t.event_id);", conn))
                unchained = (long)(await u.ExecuteScalarAsync(cancellationToken) ?? 0L);
            return new AuditChainVerification(true, count, null, null, unchained, prevHash);
        }
        finally
        {
            _dbLock.Release();
        }
    }

    public async Task<IReadOnlyList<SafetyAuditRecord>> GetSafetyAuditRecordsAsync(int limit = 100, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);

        var list = new List<SafetyAuditRecord>();

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            string query = "SELECT event_id, timestamp, event_type, source, action_id, risk_level, parameters_sha256, decision, reason, details_json, approval_id, session_id, stop_generation FROM safety_audit_trail ORDER BY timestamp DESC LIMIT @limit;";
            using var cmd = new SqliteCommand(query, conn);
            cmd.Parameters.AddWithValue("@limit", limit);

            using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var record = new SafetyAuditRecord
                {
                    EventId = reader.GetString(0),
                    Timestamp = DateTimeOffset.Parse(reader.GetString(1)),
                    EventType = reader.GetString(2),
                    Source = reader.GetString(3),
                    ActionId = reader.IsDBNull(4) ? null : reader.GetString(4),
                    RiskLevel = reader.IsDBNull(5) ? null : reader.GetString(5),
                    ParametersSha256 = reader.IsDBNull(6) ? null : reader.GetString(6),
                    Decision = reader.IsDBNull(7) ? null : reader.GetString(7),
                    Reason = reader.IsDBNull(8) ? null : reader.GetString(8),
                    DetailsJson = reader.IsDBNull(9) ? null : reader.GetString(9),
                    ApprovalId = reader.IsDBNull(10) ? null : reader.GetString(10),
                    SessionId = reader.IsDBNull(11) ? null : reader.GetString(11),
                    StopGeneration = reader.IsDBNull(12) ? 0 : (ulong)reader.GetInt64(12)
                };
                list.Add(record);
            }
            return list;
        }
        finally
        {
            _dbLock.Release();
        }
    }
}
