// Desktop shell.
//
// Double-clicking the exe starts the services, waits for the panel to answer,
// and shows it in a window. Closing the window stops everything.
//
// The webview points at http://127.0.0.1:8900 rather than loading a bundled
// copy of the page. That is not a shortcut - it is the only arrangement that
// works:
//
//   - the page needs the panel's own API for characters, settings and assets,
//     so a local server has to be running regardless
//   - 127.0.0.1 is a secure context, which is what getUserMedia and
//     AudioWorklet require
//   - the voice pipeline is reached over ws://127.0.0.1:8765, and a page
//     served from https://tauri.localhost would have that blocked as mixed
//     content
//
// Verified in spike/webview-mic: an embedded WebView2 on a loopback origin
// behaves identically to Chrome on every capability this app uses.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{WebContext, WebViewBuilder};

const PANEL_PORT: u16 = 8900;
const PANEL_URL: &str = "http://127.0.0.1:8900/";

// The voice pipeline loads Whisper and the TTS onto the GPU before it answers,
// and MuseTalk restores its cached avatars. The panel itself is up long before
// that, and the panel is all this waits for - the page shows its own status
// for the rest.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug)]
enum UserEvent {
    Ready,
    Failed,
}

// F5 and Ctrl+R handled in the page rather than through the window's key
// events: while the webview has focus the host window never sees them.
// location.reload() is also exactly the right behaviour - it re-fetches the
// modules and the stylesheet, which is what editing the panel needs.
const SHORTCUTS: &str = r#"
window.addEventListener('keydown', function (event) {
  var reload = event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key === 'r');
  if (reload) {
    event.preventDefault();
    window.location.reload();
  }
});
"#;

fn splash(message: &str, detail: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{{height:100%;margin:0}}
        body{{display:flex;align-items:center;justify-content:center;
          background:#0e0f13;color:#e9e9ee;
          font-family:"Microsoft YaHei",system-ui,sans-serif}}
        .box{{text-align:center;max-width:32em;padding:0 2em}}
        .dot{{width:9px;height:9px;margin:0 auto 18px;border-radius:50%;
          background:#e8a598;animation:p 1.1s ease-in-out infinite}}
        @keyframes p{{0%,100%{{opacity:1}}50%{{opacity:.3}}}}
        h1{{margin:0 0 10px;font-size:16px;font-weight:500}}
        p{{margin:0;font-size:13px;line-height:1.7;color:#9a9aa6;white-space:pre-wrap}}
        </style></head><body><div class="box">
        <div class="dot"></div><h1>{}</h1><p>{}</p>
        </div></body></html>"#,
        message, detail
    )
}

/// Walk up from the executable looking for the project layout.
///
/// Works both from `app/target/release/mate.exe` during development and from
/// the root of an unpacked release, without either needing to be configured.
fn find_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir: &Path = exe.parent()?;
    loop {
        if dir.join("scripts").join("services.json").is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

/// The interpreter is read from the process table rather than duplicated here,
/// so there is still one place that says how the services are launched.
fn python_from_services(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("scripts").join("services.json")).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    let python = config.get("vars")?.get("python_s2s")?.as_str()?;
    Some(python.to_string())
}

/// Splash wording comes from the same file the page uses.
///
/// This source stays ASCII-only, per the project rule, so the alternative
/// would be escape sequences nobody can read or edit. It also means the shell
/// and the page cannot end up worded differently.
struct Text(serde_json::Value);

impl Text {
    fn load(root: &Path) -> Self {
        let value = std::fs::read_to_string(root.join("web").join("i18n.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        Text(value)
    }

    fn get<'a>(&'a self, key: &str, fallback: &'a str) -> &'a str {
        self.0.get(key).and_then(|v| v.as_str()).unwrap_or(fallback)
    }
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(400),
    )
    .is_ok()
}

fn start_supervisor(root: &Path, python: &str) -> io::Result<Child> {
    let logs = root.join("var").join("logs");
    std::fs::create_dir_all(&logs)?;
    // The shell has no console, so the supervisor's merged output would go
    // nowhere. It is the first place to look when a service will not start.
    let log = File::create(logs.join("shell.log"))?;
    let errors = log.try_clone()?;

    Command::new(python)
        .arg(root.join("scripts").join("supervisor.py"))
        // If this process dies without getting to run its own cleanup - killed
        // from Task Manager, or crashed - the supervisor notices and shuts the
        // services down itself. Without it a stale voice pipeline would sit on
        // the GPU with no window to close.
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        // Anything given to the shell goes through to the supervisor, so
        // "mate.exe --skip lipsync,voice" brings up the panel alone - useful
        // when the GPU is wanted for something else.
        .args(std::env::args().skip(1))
        .current_dir(root)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors))
        .spawn()
}

fn stop_supervisor(child: &mut Child) {
    // taskkill /T rather than Child::kill: killing the supervisor alone would
    // orphan the three services it started, and an orphan holding port 8900
    // makes the next launch fail.
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.wait();
}

fn main() -> wry::Result<()> {
    let root = match find_root() {
        Some(root) => root,
        None => {
            eprintln!("Could not locate scripts/services.json above the executable.");
            std::process::exit(1);
        }
    };
    let python = python_from_services(&root)
        .unwrap_or_else(|| "python".to_string());

    // An already-running panel is adopted rather than treated as an error, the
    // same way the supervisor does it - so launching the shell while the
    // services are up from a terminal just shows them.
    let mut child = if port_open(PANEL_PORT) {
        None
    } else {
        match start_supervisor(&root, &python) {
            Ok(child) => Some(child),
            Err(err) => {
                eprintln!("Could not start the services: {err}");
                std::process::exit(1);
            }
        }
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("AI")
        .with_inner_size(tao::dpi::LogicalSize::new(1280.0, 800.0))
        .build(&event_loop)
        .expect("failed to create window");

    // WebView2 keeps a Chromium profile - cache, cookies, localStorage - and
    // by default drops it next to the executable as "mate.exe.WebView2". That
    // puts regenerable state in the code directory, which is the thing this
    // layout exists to avoid. It also matters that localStorage lives here:
    // the panel remembers the inset placement and the sidebar state in it.
    let mut context = WebContext::new(Some(root.join("var").join("webview2")));

    let text = Text::load(&root);
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_html(splash(
            text.get("shell_starting", "Starting"),
            text.get(
                "shell_starting_detail",
                "Loading the speech models onto the GPU takes about a minute the first time.",
            ),
        ))
        .with_initialization_script(SHORTCUTS)
        // F12 opens the inspector; the panel is edited while it runs.
        .with_devtools(true)
        .build(&window)?;

    // Polled on a thread so the window paints while the services come up.
    std::thread::spawn(move || {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if port_open(PANEL_PORT) {
                let _ = proxy.send_event(UserEvent::Ready);
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        let _ = proxy.send_event(UserEvent::Failed);
    });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Ready) => {
                let _ = webview.load_url(PANEL_URL);
            }
            Event::UserEvent(UserEvent::Failed) => {
                let html = splash(
                    text.get("shell_failed", "Could not start"),
                    text.get(
                        "shell_failed_detail",
                        "The panel did not come up in time. See var\\logs\\shell.log.",
                    ),
                );
                let _ = webview.load_html(&html);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if let Some(child) = child.as_mut() {
                    stop_supervisor(child);
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
