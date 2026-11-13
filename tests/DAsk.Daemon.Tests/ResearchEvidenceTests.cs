using System.Text.Json;
using DAsk.Daemon.Research;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DAsk.Daemon.Tests;

public class ResearchEvidenceTests
{
    [Fact]
    public void ExecutionEvidenceRecord_Serialization_Roundtrip()
    {
        var record = new ExecutionEvidenceRecord
        {
            RecordId = Guid.NewGuid().ToString(),
            TaskId = "task-test-01",
            ActionId = "act-test-01",
            Timestamp = DateTimeOffset.UtcNow,
            ActionMetadata = new ActionMetadata
            {
                AgentName = "TestAgent",
                ToolName = "system_check",
                Parameters = JsonSerializer.SerializeToElement(new { target = "memory" }),
                IntentDescription = "Verify available memory"
            },
            RiskAssessment = new RiskAssessment
            {
                SideEffectRisk = "None",
                Reversibility = "FullyReversible",
                PriorUncertainty = 0.05,
                PolicyGateApproved = true
            },
            PreActionObservation = new PreActionObservation
            {
                ObservationTimestamp = DateTimeOffset.UtcNow,
                SystemStateSnapshot = new Dictionary<string, object?> { ["status"] = "Normal" },
                Telemetry = new Dictionary<string, object?> { ["availRamMB"] = 3500 }
            },
            ExecutionOutcome = new ExecutionOutcome
            {
                Status = "Success",
                ExecutionDurationMs = 12.5,
                RawOutput = JsonSerializer.SerializeToElement(new { result = "OK" })
            },
            PostActionObservation = new PostActionObservation
            {
                ObservationTimestamp = DateTimeOffset.UtcNow,
                StateDivergenceDetected = false,
                ObservedChanges = new List<string> { "Memory check recorded" }
            },
            VerificationDecision = new VerificationDecision
            {
                Verified = true,
                VerificationMethod = "ProcessInspection",
                EvidenceDescription = "Telemetry verified within normal boundaries"
            }
        };

        string json = record.ToJson();
        Assert.NotNull(json);

        var restored = ExecutionEvidenceRecord.FromJson(json);
        Assert.NotNull(restored);
        Assert.Equal(record.RecordId, restored.RecordId);
        Assert.Equal("task-test-01", restored.TaskId);
        Assert.Equal("act-test-01", restored.ActionId);
        Assert.Equal("TestAgent", restored.ActionMetadata.AgentName);
        Assert.Equal(0.05, restored.RiskAssessment.PriorUncertainty);
        Assert.True(restored.VerificationDecision.Verified);
        Assert.Null(restored.RecoveryDecision);
    }

    [Fact]
    public async Task SqliteEvidenceRecorder_Records_And_Retrieves_Evidence()
    {
        string tempDb = Path.Combine(Path.GetTempPath(), $"test_evidence_{Guid.NewGuid():N}.db");
        var recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, tempDb);

        try
        {
            await recorder.InitializeAsync();

            var record1 = new ExecutionEvidenceRecord
            {
                RecordId = Guid.NewGuid().ToString(),
                TaskId = "task-suite-100",
                ActionId = "act-1",
                Timestamp = DateTimeOffset.UtcNow,
                ActionMetadata = new ActionMetadata
                {
                    AgentName = "CodingAgent",
                    ToolName = "file_read",
                    Parameters = JsonSerializer.SerializeToElement(new { path = "test.txt" })
                },
                RiskAssessment = new RiskAssessment
                {
                    SideEffectRisk = "None",
                    Reversibility = "FullyReversible",
                    PriorUncertainty = 0.0
                },
                PreActionObservation = new PreActionObservation(),
                ExecutionOutcome = new ExecutionOutcome
                {
                    Status = "Success",
                    ExecutionDurationMs = 5.0
                },
                PostActionObservation = new PostActionObservation(),
                VerificationDecision = new VerificationDecision
                {
                    Verified = true,
                    VerificationMethod = "FileExistenceCheck"
                }
            };

            var record2 = new ExecutionEvidenceRecord
            {
                RecordId = Guid.NewGuid().ToString(),
                TaskId = "task-suite-100",
                ActionId = "act-2",
                Timestamp = DateTimeOffset.UtcNow.AddSeconds(1),
                ActionMetadata = new ActionMetadata
                {
                    AgentName = "CodingAgent",
                    ToolName = "file_write",
                    Parameters = JsonSerializer.SerializeToElement(new { path = "output.txt" })
                },
                RiskAssessment = new RiskAssessment
                {
                    SideEffectRisk = "Low",
                    Reversibility = "FullyReversible",
                    PriorUncertainty = 0.1
                },
                PreActionObservation = new PreActionObservation(),
                ExecutionOutcome = new ExecutionOutcome
                {
                    Status = "Success",
                    ExecutionDurationMs = 15.0
                },
                PostActionObservation = new PostActionObservation(),
                VerificationDecision = new VerificationDecision
                {
                    Verified = true,
                    VerificationMethod = "FileExistenceCheck"
                }
            };

            await recorder.RecordEvidenceAsync(record1);
            await recorder.RecordEvidenceAsync(record2);

            // Retrieve by Record ID
            var retrieved1 = await recorder.GetEvidenceByIdAsync(record1.RecordId);
            Assert.NotNull(retrieved1);
            Assert.Equal(record1.RecordId, retrieved1.RecordId);
            Assert.Equal("CodingAgent", retrieved1.ActionMetadata.AgentName);

            // Retrieve by Task ID
            var taskRecords = await recorder.GetEvidenceByTaskIdAsync("task-suite-100");
            Assert.Equal(2, taskRecords.Count);
            Assert.Equal("act-1", taskRecords[0].ActionId);
            Assert.Equal("act-2", taskRecords[1].ActionId);
        }
        finally
        {
            if (File.Exists(tempDb))
            {
                try { File.Delete(tempDb); } catch { }
            }
        }
    }
}

