use std::sync::Arc;
use winit::window::Window;

pub struct RenderContext {
    pub surface: wgpu::Surface<'static>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub config: wgpu::SurfaceConfiguration,
    pub size: winit::dpi::PhysicalSize<u32>,
    pub window: Arc<Window>,
}

impl RenderContext {
    pub async fn new(window: Arc<Window>, backend_choice: Option<&str>) -> Result<Self, Box<dyn std::error::Error>> {
        let size = window.inner_size();

        let backends = match backend_choice.map(|s| s.to_lowercase()).as_deref() {
            Some("vulkan") => wgpu::Backends::VULKAN,
            Some("dx12") => wgpu::Backends::DX12,
            _ => wgpu::Backends::all(),
        };

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..Default::default()
        });

        let surface = instance.create_surface(window.clone())?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or("Failed to find a compatible wgpu adapter")?;

        tracing::info!(
            "wgpu Adapter selected: {:?} (Backend: {:?})",
            adapter.get_info().name,
            adapter.get_info().backend
        );

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    label: Some("D-ASK HUD wgpu Device"),
                    memory_hints: Default::default(),
                },
                None,
            )
            .await?;

        let surface_caps = surface.get_capabilities(&adapter);
        tracing::info!("Available alpha modes from surface: {:?}", surface_caps.alpha_modes);
        let surface_format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(surface_caps.formats[0]);

        // Select alpha mode: prefer Inherit (Vulkan DWM inheritance) or PreMultiplied
        let alpha_mode = surface_caps
            .alpha_modes
            .iter()
            .copied()
            .find(|&mode| mode == wgpu::CompositeAlphaMode::Inherit)
            .or_else(|| {
                surface_caps
                    .alpha_modes
                    .iter()
                    .copied()
                    .find(|&mode| mode == wgpu::CompositeAlphaMode::PreMultiplied)
            })
            .or_else(|| {
                surface_caps
                    .alpha_modes
                    .iter()
                    .copied()
                    .find(|&mode| mode == wgpu::CompositeAlphaMode::PostMultiplied)
            })
            .unwrap_or(surface_caps.alpha_modes[0]);

        tracing::info!(
            "wgpu Surface configured: Format={:?}, AlphaMode={:?}, Size={}x{}",
            surface_format, alpha_mode, size.width, size.height
        );

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        Ok(Self {
            surface,
            device,
            queue,
            config,
            size,
            window,
        })
    }

    pub fn resize(&mut self, new_size: winit::dpi::PhysicalSize<u32>) {
        if new_size.width > 0 && new_size.height > 0 {
            self.size = new_size;
            self.config.width = new_size.width;
            self.config.height = new_size.height;
            self.surface.configure(&self.device, &self.config);
        }
    }
}
