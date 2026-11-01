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
                CREATE INDEX IF NOT EXISTS idx_safety_approval_id ON safety_audit_trail (approval_id);
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

            string insertSql = @"
                INSERT OR REPLACE INTO execution_evidence (
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

    public async Task RecordSafetyAuditAsync(SafetyAuditRecord record, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);

        await _dbLock.WaitAsync(cancellationToken);
        try
        {
            using var conn = new SqliteConnection(_connectionString);
            await conn.OpenAsync(cancellationToken);

            string insertSql = @"
                INSERT OR REPLACE INTO safety_audit_trail (
                    event_id, timestamp, event_type, source, action_id, approval_id, session_id,
                    risk_level, parameters_sha256, stop_generation, decision, reason, details_json
                ) VALUES (
                    @event_id, @timestamp, @event_type, @source, @action_id, @approval_id, @session_id,
                    @risk_level, @parameters_sha256, @stop_generation, @decision, @reason, @details_json
                );
            ";

            using var cmd = new SqliteCommand(insertSql, conn);
            cmd.Parameters.AddWithValue("@event_id", record.EventId);
            cmd.Parameters.AddWithValue("@timestamp", record.Timestamp.ToString("o"));
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
            _logger.LogInformation("[SafetyAudit] Persisted safety event: {EventType} from '{Source}', Action={ActionId}, Gen={Gen}",
                record.EventType, record.Source, record.ActionId ?? "none", record.StopGeneration);
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
