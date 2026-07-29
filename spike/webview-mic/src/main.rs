// Does an embedded WebView2 let a page use the microphone?
//
// This is the one unknown that could invalidate packaging the panel as a Tauri
// desktop app. Everything else about the move is ordinary work; if the webview
// refuses getUserMedia there is no point doing any of it.
//
// It points at a probe server rather than loading a bundled page, for the same
// reason the real app should: http://127.0.0.1 is a secure context, so
// getUserMedia and AudioWorklet are both available, and the panel's own API and
// its ws:// socket stay same-origin and same-scheme. Tauri's default
// https://tauri.localhost origin would block the ws:// connection as mixed
// content.
//
// wry rather than Tauri proper: wry is the crate Tauri uses to create the
// WebView2 instance, so the permission behaviour under test is the same code
// path. Tauri adds no permission handling of its own on Windows - that is
// precisely what tauri-apps/tauri#5042 is about.

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

const PROBE_URL: &str = "http://127.0.0.1:8912/";

fn main() -> wry::Result<()> {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("WebView2 microphone probe")
        .with_inner_size(tao::dpi::LogicalSize::new(900.0, 700.0))
        .build(&event_loop)
        .expect("failed to create window");

    let _webview = WebViewBuilder::new()
        .with_url(PROBE_URL)
        // So the console is reachable if the page itself fails to load.
        .with_devtools(true)
        .build(&window)?;

    println!("Probe window open, pointing at {PROBE_URL}");
    println!("Watch the probe server console for the report.");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}
