# D-ASK Execution Evidence Schema (EES)

**Schema Version:** `1.0.0`  
**Purpose:** A structured, versioned telemetry and audit schema for recording autonomous agent actions, pre/post observations, uncertainty metrics, safety assessments, verification decisions, and recovery actions.  
**Scope:** Research instrumentation and verification telemetry (No speculative algorithms implemented).  

---

## 1. Design Principles

1. **Deterministic Accountability:** Every action taken by the assistant or its sub-agents must be linked to a root task ID, parent plan ID, and unique action execution ID.
2. **Epistemic Calibration:** Explicitly captures the agent's confidence/uncertainty score *prior* to action execution, enabling empirical calibration studies.
3. **Safety & Risk Grading:** Quantifies side-effect potential, reversibility class, and policy enforcement results.
4. **Counterfactual & Recovery Auditing:** When an action fails or produces unexpected observations, records the verification decision and subsequent recovery pathway.

---

## 2. JSON Schema Definition (`v1.0.0`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://d-ask.dev/schemas/v1/execution-evidence.json",
  "title": "D-ASK Execution Evidence Record",
  "type": "object",
  "required": [
    "schemaVersion",
    "recordId",
    "taskId",
    "actionId",
    "timestamp",
    "actionMetadata",
    "preActionObservation",
    "riskAssessment",
    "executionOutcome",
    "postActionObservation",
    "verificationDecision"
  ],
  "properties": {
    "schemaVersion": {
      "type": "string",
      "const": "1.0.0"
    },
    "recordId": {
      "type": "string",
      "format": "uuid"
    },
    "taskId": {
      "type": "string",
      "description": "Root user task or goal identifier"
    },
    "actionId": {
      "type": "string",
      "description": "Unique identifier for this single atomic action"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "actionMetadata": {
      "type": "object",
      "required": ["agentName", "toolName", "parameters"],
      "properties": {
        "agentName": { "type": "string" },
        "toolName": { "type": "string" },
        "parameters": { "type": "object" },
        "intentDescription": { "type": "string" }
      }
    },
    "riskAssessment": {
      "type": "object",
      "required": ["sideEffectRisk", "reversibility", "priorUncertainty"],
      "properties": {
        "sideEffectRisk": {
          "type": "string",
          "enum": ["None", "Low", "Medium", "High", "Critical"]
        },
        "reversibility": {
          "type": "string",
          "enum": ["FullyReversible", "PartiallyReversible", "Irreversible"]
        },
        "priorUncertainty": {
          "type": "number",
          "minimum": 0.0,
          "maximum": 1.0,
          "description": "Normalized model uncertainty score (0.0 = absolute certainty, 1.0 = pure guess)"
        },
        "policyGateApproved": { "type": "boolean" },
        "policyViolationReason": { "type": ["string", "null"] }
      }
    },
    "preActionObservation": {
      "type": "object",
      "required": ["observationTimestamp", "systemStateSnapshot"],
      "properties": {
        "observationTimestamp": { "type": "string", "format": "date-time" },
        "systemStateSnapshot": {
          "type": "object",
          "properties": {
            "foregroundWindow": { "type": "string" },
            "activeProcesses": { "type": "array", "items": { "type": "string" } },
            "targetElementExists": { "type": "boolean" }
          }
        },
        "telemetry": {
          "type": "object",
          "properties": {
            "availableMemoryMB": { "type": "number" },
            "cpuUsagePercent": { "type": "number" }
          }
        }
      }
    },
    "executionOutcome": {
      "type": "object",
      "required": ["status", "executionDurationMs"],
      "properties": {
        "status": {
          "type": "string",
          "enum": ["Success", "Failure", "Throttled", "AbortedByPolicy", "Timeout"]
        },
        "executionDurationMs": { "type": "number" },
        "rawOutput": { "type": ["string", "object", "null"] },
        "errorMessage": { "type": ["string", "null"] }
      }
    },
    "postActionObservation": {
      "type": "object",
      "required": ["observationTimestamp", "stateDivergenceDetected"],
      "properties": {
        "observationTimestamp": { "type": "string", "format": "date-time" },
        "stateDivergenceDetected": {
          "type": "boolean",
          "description": "True if system state diverged from pre-action prediction"
        },
        "observedChanges": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "verificationDecision": {
      "type": "object",
      "required": ["verified", "verificationMethod"],
      "properties": {
        "verified": { "type": "boolean" },
        "verificationMethod": {
          "type": "string",
          "enum": ["VisualInspection", "FileExistenceCheck", "ProcessInspection", "ExitCodeCheck", "SelfReported"]
        },
        "evidenceDescription": { "type": "string" }
      }
    },
    "recoveryDecision": {
      "type": ["object", "null"],
      "properties": {
        "recoveryRequired": { "type": "boolean" },
        "recoveryStrategy": {
          "type": "string",
          "enum": ["Retry", "Rollback", "AlternativeTool", "EscalateToUser", "AbortTask"]
        },
        "recoveryActionId": { "type": ["string", "null"] },
        "recoveryRationale": { "type": "string" }
      }
    },
    "finalTaskOutcome": {
      "type": ["object", "null"],
      "properties": {
        "taskCompleted": { "type": "boolean" },
        "terminalStatus": {
          "type": "string",
          "enum": ["CompletedSuccessfully", "FailedWithIntervention", "AbortedSafely", "FatalFailure"]
        },
        "totalActionsExecuted": { "type": "integer" },
        "totalDurationMs": { "type": "number" }
      }
    }
  }
}
```

---

## 3. Sample Concrete Evidence Instance

Below is a validated example representing an Android ADB tap action:

```json
{
  "schemaVersion": "1.0.0",
  "recordId": "b1f48a12-8e11-4a3e-b81f-498c19a90df1",
  "taskId": "task-user-open-settings",
  "actionId": "act-adb-tap-settings-icon",
  "timestamp": "2026-10-31T01:15:00.000Z",
  "actionMetadata": {
    "agentName": "DeviceAgent",
    "toolName": "adb_tap",
    "parameters": {
      "x": 540,
      "y": 1200,
      "deviceId": "emulator-5554"
    },
    "intentDescription": "Tap the Android Settings app icon on homescreen"
  },
  "riskAssessment": {
    "sideEffectRisk": "Low",
    "reversibility": "FullyReversible",
    "priorUncertainty": 0.08,
    "policyGateApproved": true,
    "policyViolationReason": null
  },
  "preActionObservation": {
    "observationTimestamp": "2026-10-31T01:14:59.850Z",
    "systemStateSnapshot": {
      "foregroundWindow": "Android Emulator",
      "activeProcesses": ["qemu-system-x86_64.exe", "adb.exe"],
      "targetElementExists": true
    },
    "telemetry": {
      "availableMemoryMB": 3150.4,
      "cpuUsagePercent": 14.1
    }
  },
  "executionOutcome": {
    "status": "Success",
    "executionDurationMs": 1.2,
    "rawOutput": "OK",
    "errorMessage": null
  },
  "postActionObservation": {
    "observationTimestamp": "2026-10-31T01:15:00.350Z",
    "stateDivergenceDetected": false,
    "observedChanges": [
      "Focused activity changed to com.android.settings/.Settings"
    ]
  },
  "verificationDecision": {
    "verified": true,
    "verificationMethod": "ProcessInspection",
    "evidenceDescription": "ADB dumpsys window confirmed Settings app is in foreground"
  },
  "recoveryDecision": null,
  "finalTaskOutcome": {
    "taskCompleted": true,
    "terminalStatus": "CompletedSuccessfully",
    "totalActionsExecuted": 1,
    "totalDurationMs": 512.4
  }
}
```

---

## 4. Integration Guidelines

- **Storage:** Persisted locally in `.d-ask-memory.db` (SQLite) inside a dedicated table `execution_evidence` with an indexed `taskId` column.
- **Overhead Control:** Serialized asynchronously via non-blocking write channels to prevent logging operations from impacting real-time agent execution latency.

