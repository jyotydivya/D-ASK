use crate::render::context::RenderContext;
use crate::render::interaction::CameraController;
use crate::state::hud_state::{OrbState, SharedHudState};
use std::time::Instant;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct OrbUniforms {
    pub time: f32,
    pub aspect: f32,
    pub speed: f32,
    pub pulse: f32,
    pub primary_color: [f32; 4],
    pub secondary_color: [f32; 4],
    pub camera_rot: [f32; 2],
    pub camera_zoom: f32,
    pub panel_visible: f32,
    pub cpu_usage: f32,
    pub ram_load: f32,
    pub ram_avail_gb: f32,
    pub gpu_budget_gb: f32,
    pub state_id: u32,
    pub alert_level: u32,
    pub padding: [f32; 2],
}

pub struct FrameStats {
    pub sample_count: u64,
    pub avg_frame_ms: f32,
    pub min_frame_ms: f32,
    pub max_frame_ms: f32,
    pub fps: f32,
}

pub struct OrbRenderer {
    state: SharedHudState,
    pipeline: wgpu::RenderPipeline,
    uniform_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    start_time: Instant,
    last_frame_time: Instant,
    pub frame_count: u64,
    // Frame time tracking for empirical 60 FPS performance verification
    frame_times_window: Vec<f32>,
    last_fps_report: Instant,
    pub min_frame_ms: f32,
    pub max_frame_ms: f32,
    pub total_frame_ms: f64,
    // Smoothly interpolated animation properties
    curr_prim_color: [f32; 4],
    curr_sec_color: [f32; 4],
    curr_speed: f32,
    curr_pulse: f32,
    curr_panel_anim: f32,
    // Camera controller for 3D rotation and zoom
    pub camera: CameraController,
}

impl OrbRenderer {
    pub fn new(ctx: &RenderContext, state: SharedHudState) -> Self {
        let shader = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("D-ASK Orb WGSL Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/orb.wgsl").into()),
        });

        let bind_group_layout = ctx.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("D-ASK Orb Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let (initial_state, initial_panel) = {
            let s = state.lock().unwrap();
            (s.effective_orb_state(), if s.show_telemetry_panel { 1.0f32 } else { 0.0f32 })
        };

        let initial_uniforms = OrbUniforms {
            time: 0.0,
            aspect: ctx.config.width as f32 / ctx.config.height.max(1) as f32,
            speed: 1.0,
            pulse: 1.0,
            primary_color: initial_state.primary_color(),
            secondary_color: initial_state.secondary_color(),
            camera_rot: [0.0, 0.0],
            camera_zoom: 1.0,
            panel_visible: initial_panel,
            cpu_usage: 0.0,
            ram_load: 0.0,
            ram_avail_gb: 4.0,
            gpu_budget_gb: 7.8,
            state_id: initial_state as u32,
            alert_level: 0,
            padding: [0.0, 0.0],
        };

        let uniform_buffer = ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("D-ASK Orb Uniform Buffer"),
            contents: bytemuck::cast_slice(&[initial_uniforms]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("D-ASK Orb Bind Group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        let pipeline_layout = ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("D-ASK Orb Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("D-ASK Orb Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: ctx.config.format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let now = Instant::now();
        Self {
            state,
            pipeline,
            uniform_buffer,
            bind_group,
            start_time: now,
            last_frame_time: now,
            frame_count: 0,
            frame_times_window: Vec::with_capacity(240),
            last_fps_report: now,
            min_frame_ms: f32::MAX,
            max_frame_ms: 0.0,
            total_frame_ms: 0.0,
            curr_prim_color: initial_state.primary_color(),
            curr_sec_color: initial_state.secondary_color(),
            curr_speed: initial_state.speed_multiplier(),
            curr_pulse: initial_state.pulse_frequency(),
            curr_panel_anim: initial_panel,
            camera: CameraController::new(),
        }
    }

    pub fn get_frame_stats(&self) -> FrameStats {
        let count = self.frame_count.max(1);
        let avg_ms = (self.total_frame_ms / count as f64) as f32;
        let fps = 1000.0 / avg_ms.max(0.001);
        FrameStats {
            sample_count: count,
            avg_frame_ms: avg_ms,
            min_frame_ms: if self.min_frame_ms == f32::MAX { 0.0 } else { self.min_frame_ms },
            max_frame_ms: self.max_frame_ms,
            fps,
        }
    }

    pub fn render(&mut self, ctx: &mut RenderContext) -> Result<(), wgpu::SurfaceError> {
        let now = Instant::now();
        let dt = (now - self.last_frame_time).as_secs_f32().min(0.1);
        self.last_frame_time = now;
        self.frame_count = self.frame_count.wrapping_add(1);

        // Update camera controller physics (smooth damping)
        self.camera.update(dt);

        // Record frame time for empirical benchmark telemetry
        let frame_ms = dt * 1000.0;
        self.total_frame_ms += frame_ms as f64;
        if frame_ms < self.min_frame_ms && self.frame_count > 5 {
            self.min_frame_ms = frame_ms;
        }
        if frame_ms > self.max_frame_ms && self.frame_count > 5 {
            self.max_frame_ms = frame_ms;
        }

        self.frame_times_window.push(frame_ms);
        if self.last_fps_report.elapsed().as_secs() >= 5 {
            if !self.frame_times_window.is_empty() {
                let count = self.frame_times_window.len() as f32;
                let sum: f32 = self.frame_times_window.iter().sum();
                let avg_ms = sum / count;
                let fps = 1000.0 / avg_ms.max(0.001);
                tracing::info!(
                    "[HUD FRAME TELEMETRY] Avg Frame: {:.2} ms | FPS: {:.1} | Min: {:.2} ms | Max: {:.2} ms | Samples: {}",
                    avg_ms, fps, self.min_frame_ms, self.max_frame_ms, count
                );
                self.frame_times_window.clear();
            }
            self.last_fps_report = now;
        }

        // Fetch state and telemetry
        let (orb_state, show_panel, telem, alert_level) = {
            let s = self.state.lock().unwrap();
            let effective = s.effective_orb_state();
            let alert_lvl = if s.active_alerts.iter().any(|a| a.severity == "Critical") || s.orb_mode == "Critical" || s.orb_mode == "Alert" {
                2u32
            } else if s.active_alerts.iter().any(|a| a.severity == "Warning") || s.orb_mode == "Warning" {
                1u32
            } else {
                0u32
            };
            (effective, s.show_telemetry_panel, s.latest_telemetry.clone(), alert_lvl)
        };

        // Smooth state transition lerp (decay factor = 5.0 * dt)
        let lerp_factor = (dt * 5.0).min(1.0);
        let target_prim = orb_state.primary_color();
        let target_sec = orb_state.secondary_color();
        for i in 0..4 {
            self.curr_prim_color[i] += (target_prim[i] - self.curr_prim_color[i]) * lerp_factor;
            self.curr_sec_color[i] += (target_sec[i] - self.curr_sec_color[i]) * lerp_factor;
        }
        self.curr_speed += (orb_state.speed_multiplier() - self.curr_speed) * lerp_factor;
        self.curr_pulse += (orb_state.pulse_frequency() - self.curr_pulse) * lerp_factor;

        let target_panel = if show_panel { 1.0f32 } else { 0.0f32 };
        self.curr_panel_anim += (target_panel - self.curr_panel_anim) * lerp_factor;

        let (cpu_usage, ram_load, ram_avail_gb, gpu_budget_gb) = match telem {
            Some(t) => (
                t.cpu.total_usage_percent as f32,
                t.system_ram.load_percentage as f32,
                t.system_ram.available_bytes as f32 / (1024.0 * 1024.0 * 1024.0),
                t.gpu.shared_system_memory_bytes as f32 / (1024.0 * 1024.0 * 1024.0),
            ),
            None => (0.0, 75.0, 3.8, 7.8),
        };

        let aspect = ctx.config.width as f32 / ctx.config.height.max(1) as f32;
        let time = (now - self.start_time).as_secs_f32();

        let uniforms = OrbUniforms {
            time,
            aspect,
            speed: self.curr_speed,
            pulse: self.curr_pulse,
            primary_color: self.curr_prim_color,
            secondary_color: self.curr_sec_color,
            camera_rot: [self.camera.yaw, self.camera.pitch],
            camera_zoom: self.camera.zoom,
            panel_visible: self.curr_panel_anim,
            cpu_usage,
            ram_load,
            ram_avail_gb,
            gpu_budget_gb,
            state_id: orb_state as u32,
            alert_level,
            padding: [0.0, 0.0],
        };

        ctx.queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let output = ctx.surface.get_current_texture()?;
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("D-ASK Orb Render Encoder"),
            });

        {
            // Clear with completely transparent black (r=0, g=0, b=0, a=0)
            // for native DWM transparent window compositing with WS_EX_LAYERED + LWA_COLORKEY
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("D-ASK Orb Main Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
            });

            render_pass.set_pipeline(&self.pipeline);
            render_pass.set_bind_group(0, &self.bind_group, &[]);
            render_pass.draw(0..6, 0..1); // Fullscreen procedural quad (6 vertices)
        }

        ctx.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        Ok(())
    }
}
