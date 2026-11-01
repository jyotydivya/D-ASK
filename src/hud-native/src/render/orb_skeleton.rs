use crate::render::context::RenderContext;
use crate::state::hud_state::{ConnectionStatus, SharedHudState};

pub struct OrbSkeletonRenderer {
    state: SharedHudState,
    frame_count: u64,
}

impl OrbSkeletonRenderer {
    pub fn new(state: SharedHudState) -> Self {
        Self {
            state,
            frame_count: 0,
        }
    }

    pub fn render(&mut self, ctx: &mut RenderContext) -> Result<(), wgpu::SurfaceError> {
        self.frame_count = self.frame_count.wrapping_add(1);

        let output = ctx.surface.get_current_texture()?;
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let (connection, orb_mode) = {
            let s = self.state.lock().unwrap();
            (s.connection.clone(), s.orb_mode.clone())
        };

        // Determine background tone based on connection & alert status
        let clear_color = match connection {
            ConnectionStatus::Connected => match orb_mode.as_str() {
                "Alert" => wgpu::Color {
                    r: 0.12,
                    g: 0.02,
                    b: 0.02,
                    a: 0.85,
                },
                _ => wgpu::Color {
                    r: 0.01,
                    g: 0.05,
                    b: 0.10,
                    a: 0.80,
                },
            },
            ConnectionStatus::Connecting | ConnectionStatus::Reconnecting => wgpu::Color {
                r: 0.08,
                g: 0.06,
                b: 0.01,
                a: 0.70,
            },
            _ => wgpu::Color {
                r: 0.03,
                g: 0.03,
                b: 0.03,
                a: 0.60,
            },
        };

        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("D-ASK HUD Render Encoder"),
            });

        {
            let _render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("D-ASK HUD Main Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear_color),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
            });
        }

        ctx.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        Ok(())
    }
}

