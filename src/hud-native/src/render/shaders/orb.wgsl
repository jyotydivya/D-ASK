struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    // Fullscreen quad covering clip space [-1, 1] using 6 vertices (2 triangles)
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0)
    );
    let p = pos[in_vertex_index];
    out.position = vec4<f32>(p, 0.0, 1.0);
    out.uv = p;
    return out;
}

struct OrbUniforms {
    time: f32,
    aspect: f32,
    speed: f32,
    pulse: f32,
    primary_color: vec4<f32>,
    secondary_color: vec4<f32>,
    camera_rot: vec2<f32>,   // x: yaw (theta), y: pitch (phi)
    camera_zoom: f32,
    panel_visible: f32,
    cpu_usage: f32,
    ram_load: f32,
    ram_avail_gb: f32,
    gpu_budget_gb: f32,
    state_id: u32,
    alert_level: u32,
    padding: vec2<f32>,
};

@group(0) @binding(0)
var<uniform> u: OrbUniforms;

const PI: f32 = 3.14159265359;

// 2D Rotation matrix
fn rotate2d(angle: f32) -> mat2x2<f32> {
    let s = sin(angle);
    let c = cos(angle);
    return mat2x2<f32>(c, -s, s, c);
}

// 3D Rotation matrices
fn rotate_x(angle: f32) -> mat3x3<f32> {
    let s = sin(angle);
    let c = cos(angle);
    return mat3x3<f32>(
        vec3<f32>(1.0, 0.0, 0.0),
        vec3<f32>(0.0, c, -s),
        vec3<f32>(0.0, s, c)
    );
}

fn rotate_y(angle: f32) -> mat3x3<f32> {
    let s = sin(angle);
    let c = cos(angle);
    return mat3x3<f32>(
        vec3<f32>(c, 0.0, s),
        vec3<f32>(0.0, 1.0, 0.0),
        vec3<f32>(-s, 0.0, c)
    );
}

// Pseudo-random hash
fn hash1(n: f32) -> f32 {
    return fract(sin(n) * 43758.5453123);
}

// Draw a smooth glowing ring projected in 3D
fn ring_glow_3d(p: vec2<f32>, radius: f32, thickness: f32, ring_normal: vec3<f32>, rot_mat: mat3x3<f32>, dash_freq: f32) -> f32 {
    let n_view = rot_mat * ring_normal;
    let tilt_angle = atan2(n_view.y, n_view.x);
    let squash = max(abs(n_view.z), 0.15);

    let tilted = rotate2d(-tilt_angle) * p;
    let dist_to_ring = abs(length(vec2<f32>(tilted.x / squash, tilted.y)) - radius);
    var glow = (thickness * 0.015) / (dist_to_ring * dist_to_ring * 90.0 + thickness * 0.025);

    if (dash_freq > 0.0) {
        let angle = atan2(tilted.y, tilted.x);
        let dashes = 0.5 + 0.5 * cos(angle * dash_freq);
        glow = glow * (0.35 + 0.65 * smoothstep(0.3, 0.7, dashes));
    }
    return glow;
}

// Draw a rounded rectangle mask for HUD telemetry cards
fn rounded_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // 1. Coordinates: screen space for HUD panel, scaled coordinates for orb
    let p_screen = vec2<f32>(in.uv.x * u.aspect, in.uv.y);
    let zoom = clamp(u.camera_zoom, 0.35, 2.60);
    // Center the orb slightly higher (y = +0.12) to leave room for the bottom telemetry HUD
    let p = vec2<f32>(p_screen.x, p_screen.y - 0.12) / zoom;
    let r = length(p);

    // Contextual Telemetry card bounds in screen coordinates
    let panel_center = vec2<f32>(0.0, -0.66);
    let panel_half = vec2<f32>(0.74, 0.20);
    let p_rel = p_screen - panel_center;
    let d_box = rounded_box(p_rel, panel_half, 0.03);

    // -------------------------------------------------------------
    // Guaranteed DWM Transparency Check:
    // If outside both the circular orb and telemetry card:
    // Return pure transparent black (0.0) so Windows DWM LWA_COLORKEY passes through 100% to desktop
    // -------------------------------------------------------------
    let in_orb_region = r < 0.60;
    let in_panel_region = u.panel_visible > 0.05 && d_box < 0.04;
    if (!in_orb_region && !in_panel_region) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Dynamic pulse factor (breathing rhythm)
    let breathing = 1.0 + 0.07 * sin(u.time * u.pulse * 2.0 * PI);
    let core_radius = 0.30 * breathing;

    var color = vec3<f32>(0.0, 0.0, 0.0);
    var alpha = 0.0;

    let prim = u.primary_color.rgb;
    let sec = u.secondary_color.rgb;

    // 3D Camera view rotation matrix
    let rot_mat = rotate_x(u.camera_rot.y) * rotate_y(u.camera_rot.x);

    // -------------------------------------------------------------
    // 1. Procedural Holographic Sphere Core
    // -------------------------------------------------------------
    if (r < core_radius) {
        let z = sqrt(max(core_radius * core_radius - r * r, 0.0));
        let pos3d = vec3<f32>(p.x, p.y, z);
        let normal = pos3d / core_radius;

        // Rotate surface point by 3D camera orientation
        let rot_pos = rot_mat * normal;

        // Fresnel edge glow (view vector is (0, 0, 1))
        let fresnel = pow(1.0 - max(normal.z, 0.0), 2.4);

        // Volumetric energy texture inside the sphere, rotated in 3D
        let swirl_time = u.time * u.speed * 0.7;
        let flow1 = sin(rot_pos.x * 10.0 + swirl_time * 2.0) * cos(rot_pos.y * 10.0 - swirl_time * 1.5);
        let flow2 = cos((rot_pos.x + rot_pos.z) * 8.0 + swirl_time * 2.5);
        let energy = 0.5 + 0.5 * (flow1 + flow2 * 0.5);

        // Core color blending
        let core_color = mix(sec * 0.45, prim, fresnel * 0.70 + energy * 0.30);
        color += core_color * (0.85 + 0.40 * energy);
        alpha = max(alpha, 0.75 + fresnel * 0.25);
    }

    // Outer core rim aura
    let rim_dist = abs(r - core_radius);
    let rim_aura = 0.025 / (rim_dist * 35.0 + 0.08);
    color += prim * rim_aura * 1.25;
    alpha = max(alpha, rim_aura * 0.85);

    // -------------------------------------------------------------
    // 2. Three Counter-Rotating Gimbal / Gyroscope Rings in 3D
    // -------------------------------------------------------------
    let t = u.time * u.speed;

    // Ring 1 (Inner Gimbal - tilted ~35 degrees, spinning fast)
    let n1 = vec3<f32>(sin(t * 1.1) * 0.6, cos(t * 1.1) * 0.6, 0.8);
    let ring1 = ring_glow_3d(p, core_radius * 1.15, 0.75, normalize(n1), rot_mat, 12.0);

    // Ring 2 (Middle Gimbal - counter-rotating, tilted ~50 degrees)
    let n2 = vec3<f32>(cos(-t * 0.85 + 0.7) * 0.7, sin(-t * 0.85 + 0.7) * 0.7, -0.6);
    let ring2 = ring_glow_3d(p, core_radius * 1.35, 0.80, normalize(n2), rot_mat, 16.0);

    // Ring 3 (Outer Horizon Ring - slow rotation)
    let n3 = vec3<f32>(0.2, sin(t * 0.45) * 0.3, 0.95);
    let ring3 = ring_glow_3d(p, core_radius * 1.58, 0.85, normalize(n3), rot_mat, 24.0);

    let rings_combined = ring1 * 0.9 + ring2 * 0.85 + ring3 * 0.75;
    color += mix(sec, prim, 0.65) * rings_combined;
    alpha = max(alpha, min(rings_combined * 0.9, 0.95));

    // -------------------------------------------------------------
    // 3. Orbiting Particle Field (18 Lissajous particles in 3D)
    // -------------------------------------------------------------
    var particle_glow = 0.0;
    for (var i = 0u; i < 18u; i = i + 1u) {
        let fi = f32(i);
        let seed = hash1(fi * 1.17 + 0.5);
        let orbit_r = core_radius * (1.10 + 0.60 * seed);
        let orbit_speed = (0.6 + 0.8 * hash1(fi * 2.33)) * (1.0 - 2.0 * f32(i % 2u));
        let phase = fi * (2.0 * PI / 18.0);
        let angle = t * orbit_speed + phase;

        // 3D Lissajous orbit trajectory
        let pos_local = vec3<f32>(
            cos(angle) * orbit_r,
            sin(angle) * orbit_r * 0.45,
            sin(angle * 1.5 + phase) * orbit_r * 0.65
        );

        // Rotate orbit in 3D by camera rotation
        let pos_view = rot_mat * pos_local;

        // Depth attenuation: particles in foreground (pos_view.z > 0) are brighter
        let depth_factor = 0.5 + 0.5 * (pos_view.z / orbit_r);
        let d = length(p - pos_view.xy);
        let pt_brightness = (0.0038 / (d * d * 340.0 + 0.018)) * (0.4 + 0.9 * depth_factor);
        particle_glow += pt_brightness;
    }
    color += prim * particle_glow * 1.35;
    alpha = max(alpha, min(particle_glow * 0.85, 0.95));

    // -------------------------------------------------------------
    // 4. State-Specific Visual Enhancements (12 Canonical States)
    // -------------------------------------------------------------

    // State 1: Listening (Electric blue responsive audio waveform ripple)
    if (u.state_id == 1u) {
        let ripple_r = core_radius * (1.05 + 0.20 * sin(u.time * 6.0));
        let ripple_dist = abs(r - ripple_r);
        let ripple = 0.02 / (ripple_dist * 40.0 + 0.06);
        color += prim * ripple * 1.4;
        alpha = max(alpha, ripple * 0.8);
    }

    // State 3: Speaking (Warm gold concentric harmonic waves)
    if (u.state_id == 3u) {
        let speak_wave = 0.5 + 0.5 * sin(r * 28.0 - u.time * 8.0);
        let speak_glow = speak_wave * (0.02 / (rim_dist * 25.0 + 0.08));
        color += vec3<f32>(1.0, 0.85, 0.2) * speak_glow * 1.3;
        alpha = max(alpha, speak_glow * 0.75);
    }

    // State 4: ModelLoading (Inward gravitational energy accretion)
    if (u.state_id == 4u) {
        let accrete_r = fract(-u.time * 0.8) * core_radius * 1.5;
        let accrete_dist = abs(r - accrete_r);
        let accrete = 0.025 / (accrete_dist * 35.0 + 0.05);
        color += vec3<f32>(0.3, 0.6, 1.0) * accrete * 1.4;
        alpha = max(alpha, accrete * 0.8);
    }

    // State 5: ModelGenerating (High-velocity swirl & neon magenta particulate flux)
    if (u.state_id == 5u) {
        let swirl_wave = sin(atan2(p.y, p.x) * 6.0 - u.time * 9.0);
        let swirl_glow = smoothstep(0.3, 0.85, swirl_wave) * (0.03 / (rim_dist * 20.0 + 0.09));
        color += vec3<f32>(1.0, 0.2, 0.8) * swirl_glow * 1.4;
        alpha = max(alpha, swirl_glow * 0.8);
    }

    // State 6: Warning (Vivid amber alert pulse)
    if (u.state_id == 6u || u.alert_level == 1u) {
        let warn_pulse = 0.5 + 0.5 * sin(u.time * 2.5 * 2.0 * PI);
        let warn_halo = 0.03 / (rim_dist * 22.0 + 0.1) * (0.8 + 0.4 * warn_pulse);
        color += vec3<f32>(1.0, 0.55, 0.05) * warn_halo * 1.5;
        alpha = max(alpha, warn_halo * 0.85);
    }

    // State 7: Critical (Persistent, deep crimson breathing halo — NO rapid strobe!)
    if (u.state_id == 7u || u.alert_level == 2u) {
        let crit_halo_dist = abs(r - core_radius * 1.70);
        let crit_pulse = 0.5 + 0.5 * sin(u.time * 0.9 * 2.0 * PI); // Calm 0.9 Hz persistent breath
        let crit_halo = 0.05 / (crit_halo_dist * 18.0 + 0.10) * (0.85 + 0.25 * crit_pulse);
        let crit_color = vec3<f32>(0.95, 0.04, 0.04);
        color += crit_color * crit_halo * 1.8;
        alpha = max(alpha, crit_halo * 0.90);
    }

    // State 9: Reconnecting (Outward seeking radar pulse)
    if (u.state_id == 9u) {
        let wave_r = fract(u.time * 0.6) * 0.85;
        let wave_dist = abs(r - wave_r);
        let wave_glow = (1.0 - wave_r / 0.85) * (0.02 / (wave_dist * 40.0 + 0.05));
        color += prim * wave_glow * 1.5;
        alpha = max(alpha, wave_glow * 0.8);
    }

    // State 10: TaskCompleted (Emerald green expanding celebratory ring)
    if (u.state_id == 10u) {
        let comp_pulse = fract(u.time * 0.8);
        let comp_r = core_radius * (1.0 + 0.8 * comp_pulse);
        let comp_dist = abs(r - comp_r);
        let comp_glow = (1.0 - comp_pulse) * (0.03 / (comp_dist * 30.0 + 0.06));
        color += vec3<f32>(0.1, 0.95, 0.3) * comp_glow * 1.6;
        alpha = max(alpha, comp_glow * 0.85);
    }

    // State 11: TaskFailed (Crimson error flare ring)
    if (u.state_id == 11u) {
        let fail_pulse = fract(u.time * 1.2);
        let fail_r = core_radius * (1.0 + 0.6 * fail_pulse);
        let fail_dist = abs(r - fail_r);
        let fail_glow = (1.0 - fail_pulse) * (0.03 / (fail_dist * 32.0 + 0.07));
        color += vec3<f32>(0.9, 0.1, 0.1) * fail_glow * 1.5;
        alpha = max(alpha, fail_glow * 0.8);
    }

    // -------------------------------------------------------------
    // 5. Contextual Telemetry HUD Overlay Panel (Pinned in Screen Space)
    // -------------------------------------------------------------
    if (u.panel_visible > 0.01) {
        if (d_box < 0.0) {
            // Panel background (glassmorphic dark slate with subtle tint)
            let panel_bg = vec3<f32>(0.04, 0.07, 0.12) * 0.88 + sec * 0.06;
            let panel_alpha = 0.85 * u.panel_visible;

            // Metric Bar 1: CPU Usage (top bar: y in [0.07, 0.12], x in [-0.60, 0.60])
            let cpu_norm_x = (p_rel.x - (-0.60)) / 1.20;
            let in_cpu_bar_y = p_rel.y > 0.07 && p_rel.y < 0.12;
            let in_cpu_bar_x = cpu_norm_x >= 0.0 && cpu_norm_x <= 1.0;
            var bar_color = vec3<f32>(0.0, 0.0, 0.0);

            if (in_cpu_bar_y && in_cpu_bar_x) {
                if (cpu_norm_x <= (u.cpu_usage / 100.0)) {
                    bar_color = mix(vec3<f32>(0.1, 0.8, 0.3), vec3<f32>(0.9, 0.3, 0.1), u.cpu_usage / 100.0);
                } else {
                    bar_color = vec3<f32>(0.15, 0.20, 0.25);
                }
            }

            // Metric Bar 2: RAM Usage (middle bar: y in [-0.02, 0.03], x in [-0.60, 0.60])
            let ram_norm_x = (p_rel.x - (-0.60)) / 1.20;
            let in_ram_bar_y = p_rel.y > -0.02 && p_rel.y < 0.03;
            let in_ram_bar_x = ram_norm_x >= 0.0 && ram_norm_x <= 1.0;

            if (in_ram_bar_y && in_ram_bar_x) {
                if (ram_norm_x <= (u.ram_load / 100.0)) {
                    bar_color = mix(vec3<f32>(0.1, 0.7, 1.0), vec3<f32>(0.95, 0.6, 0.1), u.ram_load / 100.0);
                } else {
                    bar_color = vec3<f32>(0.15, 0.20, 0.25);
                }
            }

            // Metric Bar 3: GPU Shared System Memory (UMA Budget) indicator
            let gpu_norm_x = (p_rel.x - (-0.60)) / 1.20;
            let in_gpu_bar_y = p_rel.y > -0.14 && p_rel.y < -0.08;
            let in_gpu_bar_x = gpu_norm_x >= 0.0 && gpu_norm_x <= 1.0;

            if (in_gpu_bar_y && in_gpu_bar_x) {
                let segment = floor(gpu_norm_x * 12.0);
                let segment_fill = segment / 12.0;
                if (segment_fill <= 0.5) { // 50% UMA reserved budget (7.8 GB of 16 GB host RAM)
                    bar_color = vec3<f32>(0.2, 0.5, 0.9);
                } else {
                    bar_color = vec3<f32>(0.12, 0.16, 0.22);
                }
            }

            let final_pixel = mix(panel_bg, bar_color, step(0.001, length(bar_color)));
            color = mix(color, final_pixel, panel_alpha);
            alpha = max(alpha, panel_alpha);
        }

        // Panel neon border glow
        let border_dist = abs(d_box);
        let border_glow = (0.015 / (border_dist * 45.0 + 0.06)) * u.panel_visible;
        color += prim * border_glow * 1.1;
        alpha = max(alpha, border_glow * 0.9);
    }

    // -------------------------------------------------------------
    // 6. Transparent Windows DWM Color-Keying Output
    // -------------------------------------------------------------
    let clamped_alpha = clamp(alpha, 0.0, 1.0);
    if (clamped_alpha < 0.01) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
    return vec4<f32>(color * clamped_alpha, clamped_alpha);
}
