use crate::ipc::protocol::{ResourceAlert, StateRestoreResponse, StateUpdate, TaskStateDto, TelemetryUpdate};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Handshaking,
    Connected,
    Reconnecting,
}

/// Canonical 12 Assistant and Orb states agreed between .NET Daemon and Rust HUD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum OrbState {
    #[default]
    Idle,
    Listening,
    Processing,
    Speaking,
    ModelLoading,
    ModelGenerating,
    Warning,
    Critical,
    Disconnected,
    Reconnecting,
    TaskCompleted,
    TaskFailed,
}

impl OrbState {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "Idle" => Some(Self::Idle),
            "Listening" => Some(Self::Listening),
            "Processing" => Some(Self::Processing),
            "Speaking" => Some(Self::Speaking),
            "ModelLoading" => Some(Self::ModelLoading),
            "ModelGenerating" | "Generating" => Some(Self::ModelGenerating),
            "Warning" => Some(Self::Warning),
            "Critical" | "Alert" => Some(Self::Critical),
            "Disconnected" => Some(Self::Disconnected),
            "Reconnecting" => Some(Self::Reconnecting),
            "TaskCompleted" => Some(Self::TaskCompleted),
            "TaskFailed" => Some(Self::TaskFailed),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Listening => "Listening",
            Self::Processing => "Processing",
            Self::Speaking => "Speaking",
            Self::ModelLoading => "ModelLoading",
            Self::ModelGenerating => "ModelGenerating",
            Self::Warning => "Warning",
            Self::Critical => "Critical",
            Self::Disconnected => "Disconnected",
            Self::Reconnecting => "Reconnecting",
            Self::TaskCompleted => "TaskCompleted",
            Self::TaskFailed => "TaskFailed",
        }
    }

    /// Primary RGBA color for the holographic core and rim
    pub fn primary_color(&self) -> [f32; 4] {
        match self {
            Self::Idle => [0.0, 0.75, 1.0, 1.0],            // Cyan / Azure
            Self::Listening => [0.15, 0.55, 1.0, 1.0],       // Electric Blue
            Self::Processing => [0.65, 0.25, 1.0, 1.0],      // Purple / Violet
            Self::Speaking => [1.0, 0.78, 0.15, 1.0],        // Warm Amber / Gold
            Self::ModelLoading => [0.25, 0.45, 0.95, 1.0],   // Deep Indigo
            Self::ModelGenerating => [1.0, 0.15, 0.75, 1.0], // Neon Magenta
            Self::Warning => [1.0, 0.55, 0.05, 1.0],         // Vivid Amber
            Self::Critical => [0.92, 0.06, 0.06, 1.0],       // Persistent Deep Crimson (non-strobing)
            Self::Disconnected => [0.45, 0.48, 0.52, 0.8],   // Desaturated Slate
            Self::Reconnecting => [0.95, 0.82, 0.15, 0.9],   // Seeking Amber-Yellow
            Self::TaskCompleted => [0.12, 0.92, 0.35, 1.0],  // Emerald Green
            Self::TaskFailed => [0.88, 0.18, 0.18, 1.0],     // Flare Red
        }
    }

    /// Secondary RGBA color for inner glow and gimbal rings
    pub fn secondary_color(&self) -> [f32; 4] {
        match self {
            Self::Idle => [0.0, 0.3, 0.8, 0.8],
            Self::Listening => [0.05, 0.25, 0.9, 0.9],
            Self::Processing => [0.35, 0.05, 0.7, 0.9],
            Self::Speaking => [0.8, 0.4, 0.05, 0.8],
            Self::ModelLoading => [0.1, 0.7, 0.9, 0.8],
            Self::ModelGenerating => [0.7, 0.05, 0.9, 0.9],
            Self::Warning => [0.7, 0.25, 0.0, 0.8],
            Self::Critical => [0.5, 0.02, 0.02, 0.9],
            Self::Disconnected => [0.2, 0.22, 0.25, 0.6],
            Self::Reconnecting => [0.6, 0.5, 0.05, 0.7],
            Self::TaskCompleted => [0.05, 0.6, 0.2, 0.8],
            Self::TaskFailed => [0.5, 0.05, 0.05, 0.8],
        }
    }

    /// Animation speed multiplier for gimbal rings & particle flow
    pub fn speed_multiplier(&self) -> f32 {
        match self {
            Self::Idle => 1.0,
            Self::Listening => 1.8,
            Self::Processing => 3.0,
            Self::Speaking => 2.2,
            Self::ModelLoading => 2.0,
            Self::ModelGenerating => 3.8,
            Self::Warning => 1.5,
            Self::Critical => 0.85, // Persistent, calm breathing halo without rapid flashing
            Self::Disconnected => 0.3,
            Self::Reconnecting => 1.6,
            Self::TaskCompleted => 1.4,
            Self::TaskFailed => 1.2,
        }
    }

    /// Breathing pulse frequency (Hz)
    pub fn pulse_frequency(&self) -> f32 {
        match self {
            Self::Idle => 1.0,
            Self::Listening => 2.2,
            Self::Processing => 3.0,
            Self::Speaking => 2.8,
            Self::ModelLoading => 1.8,
            Self::ModelGenerating => 4.0,
            Self::Warning => 2.0,
            Self::Critical => 0.9, // Gentle 0.9 Hz persistent deep crimson halo pulse
            Self::Disconnected => 0.4,
            Self::Reconnecting => 1.8,
            Self::TaskCompleted => 1.5,
            Self::TaskFailed => 1.5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct HudState {
    pub connection: ConnectionStatus,
    pub active_status: String,
    pub orb_mode: String,
    pub latest_telemetry: Option<TelemetryUpdate>,
    pub active_alerts: Vec<ResourceAlert>,
    pub active_tasks: Vec<TaskStateDto>,
    pub last_sequence: i64,
    pub show_telemetry_panel: bool,
    pub panic_hotkey_registered: bool,
    pub panic_hotkey_error: Option<String>,
    pub is_emergency_stopped: bool,
    pub stop_generation: u64,
    pub session_id: Option<String>,
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            connection: ConnectionStatus::Disconnected,
            active_status: "Idle".to_string(),
            orb_mode: "Normal".to_string(),
            latest_telemetry: None,
            active_alerts: Vec::new(),
            active_tasks: Vec::new(),
            last_sequence: 0,
            show_telemetry_panel: true,
            panic_hotkey_registered: false,
            panic_hotkey_error: None,
            is_emergency_stopped: false,
            stop_generation: 1,
            session_id: None,
        }
    }
}

pub type SharedHudState = Arc<Mutex<HudState>>;

impl HudState {
    pub fn new_shared() -> SharedHudState {
        Arc::new(Mutex::new(Self::default()))
    }

    pub fn apply_telemetry(&mut self, telemetry: TelemetryUpdate) {
        self.latest_telemetry = Some(telemetry);
    }

    pub fn apply_alert(&mut self, alert: ResourceAlert) {
        if alert.severity == "Critical" {
            self.orb_mode = "Critical".to_string();
        } else if alert.severity == "Warning" && self.orb_mode != "Critical" {
            self.orb_mode = "Warning".to_string();
        }
        self.active_alerts.push(alert);
        if self.active_alerts.len() > 10 {
            self.active_alerts.remove(0);
        }
    }

    pub fn apply_state_update(&mut self, update: StateUpdate) {
        self.active_status = update.active_status;
        self.orb_mode = update.orb_mode;
        self.last_sequence = update.sequence_number;
    }

    pub fn apply_restore(&mut self, restore: StateRestoreResponse) {
        self.active_status = restore.active_status;
        self.orb_mode = restore.orb_mode;
        self.active_tasks = restore.active_tasks;
        self.last_sequence = restore.sequence_number;
        tracing::info!(
            "Restored HUD state: status='{}', orb_mode='{}', tasks={}, seq={}",
            self.active_status, self.orb_mode, self.active_tasks.len(), self.last_sequence
        );
    }

    pub fn toggle_telemetry_panel(&mut self) {
        self.show_telemetry_panel = !self.show_telemetry_panel;
    }

    /// Computes the effective canonical OrbState based on connection, alerts, and daemon status
    pub fn effective_orb_state(&self) -> OrbState {
        match self.connection {
            ConnectionStatus::Disconnected => OrbState::Disconnected,
            ConnectionStatus::Connecting | ConnectionStatus::Reconnecting => OrbState::Reconnecting,
            ConnectionStatus::Handshaking => OrbState::Processing,
            ConnectionStatus::Connected => {
                // If emergency stop is latched, display Critical crimson halo immediately
                if self.is_emergency_stopped || self.active_status == "EmergencyStop" || self.orb_mode == "EmergencyStop" {
                    return OrbState::Critical;
                }
                // Check if any critical alert is active
                if self.active_alerts.iter().any(|a| a.severity == "Critical") || self.orb_mode == "Critical" || self.orb_mode == "Alert" {
                    return OrbState::Critical;
                }
                if self.active_alerts.iter().any(|a| a.severity == "Warning") || self.orb_mode == "Warning" {
                    return OrbState::Warning;
                }

                // Check status from daemon
                if let Some(state) = OrbState::from_str(&self.active_status) {
                    return state;
                }
                if let Some(state) = OrbState::from_str(&self.orb_mode) {
                    return state;
                }

                OrbState::Idle
            }
        }
    }
}
