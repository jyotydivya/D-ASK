/// Interaction abstraction and camera controller for D-ASK Holographic HUD.
///
/// Implements the architecture defined in docs/previous-orb-feature-preservation.md:
/// - Camera spherical rotation (yaw, pitch) with smooth damping
/// - Dynamic zoom scaling with clamped boundaries
/// - Decoupled InteractionEvent model compatible with native mouse/keyboard and future MediaPipe vision

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InteractionEvent {
    /// Rotate the 3D orb by spherical angle deltas (radians)
    OrbRotate { delta_theta: f32, delta_phi: f32 },
    /// Zoom the 3D orb by a multiplicative factor
    OrbZoom { factor: f32 },
    /// Reset camera view angles and zoom to default
    ResetView,
    /// Toggle contextual telemetry HUD panel overlay
    ToggleTelemetryPanel,
}

#[derive(Debug, Clone)]
pub struct CameraController {
    // Current interpolated values uploaded to shader
    pub yaw: f32,
    pub pitch: f32,
    pub zoom: f32,

    // Target values driven by user interaction
    pub target_yaw: f32,
    pub target_pitch: f32,
    pub target_zoom: f32,

    // Mouse drag state tracking
    pub is_rotating: bool,
    pub drag_start_pos: (f64, f64),
    pub last_mouse_pos: (f64, f64),
    pub drag_distance: f64,
}

impl Default for CameraController {
    fn default() -> Self {
        Self {
            yaw: 0.0,
            pitch: 0.0,
            zoom: 1.0,
            target_yaw: 0.0,
            target_pitch: 0.0,
            target_zoom: 1.0,
            is_rotating: false,
            drag_start_pos: (0.0, 0.0),
            last_mouse_pos: (0.0, 0.0),
            drag_distance: 0.0,
        }
    }
}

impl CameraController {
    pub fn new() -> Self {
        Self::default()
    }

    /// Dispatch a normalized interaction event to update camera targets
    pub fn dispatch(&mut self, event: InteractionEvent) {
        match event {
            InteractionEvent::OrbRotate { delta_theta, delta_phi } => {
                self.target_yaw += delta_theta;
                // Clamp pitch to prevent gimbal singularity (-80 deg to +80 deg)
                self.target_pitch = (self.target_pitch + delta_phi).clamp(-1.40, 1.40);
            }
            InteractionEvent::OrbZoom { factor } => {
                // Clamp zoom scale between 0.35x and 2.60x
                self.target_zoom = (self.target_zoom * factor).clamp(0.35, 2.60);
            }
            InteractionEvent::ResetView => {
                self.target_yaw = 0.0;
                self.target_pitch = 0.0;
                self.target_zoom = 1.0;
            }
            InteractionEvent::ToggleTelemetryPanel => {
                // Handled in hud_state
            }
        }
    }

    /// Update camera controller physics with exponential smoothing / damping
    pub fn update(&mut self, dt: f32) {
        let damping = (1.0 - (-14.0 * dt).exp()).clamp(0.0, 1.0);
        self.yaw += (self.target_yaw - self.yaw) * damping;
        self.pitch += (self.target_pitch - self.pitch) * damping;
        self.zoom += (self.target_zoom - self.zoom) * damping;
    }

    pub fn on_right_down(&mut self, x: f64, y: f64) {
        self.is_rotating = true;
        self.drag_start_pos = (x, y);
        self.last_mouse_pos = (x, y);
        self.drag_distance = 0.0;
    }

    pub fn on_mouse_move(&mut self, x: f64, y: f64) {
        if self.is_rotating {
            let dx = (x - self.last_mouse_pos.0) as f32;
            let dy = (y - self.last_mouse_pos.1) as f32;
            self.drag_distance += ((dx * dx + dy * dy) as f64).sqrt();

            // Sensitivity: ~0.007 radians per pixel
            self.dispatch(InteractionEvent::OrbRotate {
                delta_theta: dx * 0.007,
                delta_phi: -dy * 0.007,
            });

            self.last_mouse_pos = (x, y);
        }
    }

    /// Returns true if the right mouse release was a click rather than a drag (< 6 pixels)
    pub fn on_right_up(&mut self) -> bool {
        let was_rotating = self.is_rotating;
        self.is_rotating = false;
        let was_click = was_rotating && self.drag_distance < 6.0;
        self.drag_distance = 0.0;
        was_click
    }

    pub fn on_mouse_wheel(&mut self, delta_y: f32) {
        // Positive delta zooms in, negative zooms out
        let factor = if delta_y > 0.0 { 1.10 } else { 0.90 };
        self.dispatch(InteractionEvent::OrbZoom { factor });
    }
}

