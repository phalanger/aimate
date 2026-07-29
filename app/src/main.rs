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
use std::os::windows::process::CommandExt;
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
// Whisper and the TTS have to reach the GPU before a conversation can start,
// and MuseTalk restores its cached avatars. The window waits for all of it
// rather than appearing early: a panel that is visible but cannot connect
// invites clicking things that then fail, which reads as a broken install.
const READY_TIMEOUT: Duration = Duration::from_secs(600);

// This is a GUI process, so every console program it starts would otherwise
// be given a console window of its own - one flashing up for the supervisor
// on launch, another for taskkill on the way out.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
enum UserEvent {
    /// Startup progress, as JSON, to render on the loading screen.
    Progress(String),
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

// `labels` carries the per-state marks and the "optional" tag as JSON. They
// come from web/i18n.json for the same reason the headings do: this file stays
// ASCII-only, and the shell should not word things differently from the page.
fn splash(message: &str, detail: &str, labels: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{{height:100%;margin:0}}
        body{{display:flex;align-items:center;justify-content:center;
          background:#0e0f13;color:#e9e9ee;
          font-family:"Microsoft YaHei",system-ui,sans-serif}}
        .box{{width:22em;padding:0 2em}}
        .dot{{width:9px;height:9px;margin:0 auto 18px;border-radius:50%;
          background:#e8a598;animation:p 1.1s ease-in-out infinite}}
        @keyframes p{{0%,100%{{opacity:1}}50%{{opacity:.3}}}}
        h1{{margin:0 0 10px;font-size:16px;font-weight:500;text-align:center}}
        p{{margin:0;font-size:13px;line-height:1.7;color:#9a9aa6;
          white-space:pre-wrap;text-align:center}}
        ul{{list-style:none;margin:22px 0 0;padding:0}}
        li{{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:13px;
          color:#9a9aa6;border-bottom:1px solid rgba(255,255,255,.05)}}
        li:last-child{{border-bottom:none}}
        .mark{{flex:none;width:1.2em;text-align:center}}
        li[data-state="ready"]{{color:#e9e9ee}}
        li[data-state="ready"] .mark{{color:#6fbf8f}}
        li[data-state="starting"] .mark{{color:#d9c07a}}
        li[data-state="failed"]{{color:#e88b8b}}
        li[data-state="failed"] .mark{{color:#e88b8b}}
        .opt{{margin-left:auto;font-size:11px;opacity:.6}}
        </style></head><body><div class="box">
        <div class="dot"></div><h1>{}</h1><p>{}</p><ul id="svc"></ul>
        </div>
        <script>
        var LABELS = {};
        var MARKS = LABELS.marks || {{}};
        window.setProgress = function (payload) {{
          var list = document.getElementById("svc");
          if (!list) return;
          list.textContent = "";
          (payload.services || []).forEach(function (service) {{
            var row = document.createElement("li");
            row.dataset.state = service.state;
            var mark = document.createElement("span");
            mark.className = "mark";
            mark.textContent = MARKS[service.state] || MARKS.waiting || "";
            var name = document.createElement("span");
            name.textContent = service.label;
            row.appendChild(mark);
            row.appendChild(name);
            if (service.optional && LABELS.optional) {{
              var tag = document.createElement("span");
              tag.className = "opt";
              tag.textContent = LABELS.optional;
              row.appendChild(tag);
            }}
            list.appendChild(row);
          }});
        }};
        </script></body></html>"#,
        message, detail, labels
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

/// Where the window was last left.
///
/// Kept in var/ with the rest of the regenerable state rather than in the
/// WebView2 profile, which belongs to the page.
fn geometry_path(root: &Path) -> PathBuf {
    root.join("var").join("run").join("window.json")
}

fn load_geometry(root: &Path) -> Option<(f64, f64, Option<(f64, f64)>)> {
    let text = std::fs::read_to_string(geometry_path(root)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let width = value.get("width")?.as_f64()?;
    let height = value.get("height")?.as_f64()?;
    // Refuse something unusable: a window restored at 20x20, or one saved on a
    // monitor that is no longer attached, cannot be recovered by dragging.
    if !(width >= 640.0 && height >= 480.0 && width < 20000.0 && height < 20000.0) {
        return None;
    }
    let position = match (value.get("x").and_then(|v| v.as_f64()), value.get("y").and_then(|v| v.as_f64())) {
        (Some(x), Some(y)) if x > -20000.0 && y > -20000.0 => Some((x, y)),
        _ => None,
    };
    Some((width, height, position))
}

fn save_geometry(root: &Path, window: &tao::window::Window) {
    // Logical units, so moving the window to a display with a different
    // scaling factor does not resize it on the next launch.
    let scale = window.scale_factor();
    let size = window.inner_size().to_logical::<f64>(scale);
    let mut payload = serde_json::json!({ "width": size.width, "height": size.height });
    if let Ok(position) = window.outer_position() {
        let position = position.to_logical::<f64>(scale);
        payload["x"] = serde_json::json!(position.x);
        payload["y"] = serde_json::json!(position.y);
    }
    let path = geometry_path(root);
    if let Some(folder) = path.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    let _ = std::fs::write(path, payload.to_string());
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
    // Last run's file still says done. Removing it before the supervisor
    // starts means the loading screen cannot briefly read a finished startup
    // that has not begun.
    let _ = std::fs::remove_file(root.join("var").join("run").join("status.json"));
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
        .creation_flags(CREATE_NO_WINDOW)
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
        .creation_flags(CREATE_NO_WINDOW)
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

    let saved = load_geometry(&root);
    let (width, height) = saved.map(|(w, h, _)| (w, h)).unwrap_or((1280.0, 800.0));
    let mut builder = WindowBuilder::new()
        .with_title("AI")
        .with_inner_size(tao::dpi::LogicalSize::new(width, height));
    if let Some((_, _, Some((x, y)))) = saved {
        builder = builder.with_position(tao::dpi::LogicalPosition::new(x, y));
    }
    let window = builder.build(&event_loop).expect("failed to create window");

    // WebView2 keeps a Chromium profile - cache, cookies, localStorage - and
    // by default drops it next to the executable as "mate.exe.WebView2". That
    // puts regenerable state in the code directory, which is the thing this
    // layout exists to avoid. It also matters that localStorage lives here:
    // the panel remembers the inset placement and the sidebar state in it.
    let mut context = WebContext::new(Some(root.join("var").join("webview2")));

    let text = Text::load(&root);
    let labels = serde_json::json!({
        "optional": text.get("shell_optional", "optional"),
        "marks": {
            "ready": text.get("shell_mark_ready", "ok"),
            "starting": text.get("shell_mark_starting", "..."),
            "failed": text.get("shell_mark_failed", "x"),
            "waiting": text.get("shell_mark_waiting", "-"),
        }
    })
    .to_string();

    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_html(splash(
            text.get("shell_starting", "Starting"),
            text.get(
                "shell_starting_detail",
                "Loading the speech models onto the GPU takes about a minute the first time.",
            ),
            &labels,
        ))
        .with_initialization_script(SHORTCUTS)
        // F12 opens the inspector; the panel is edited while it runs.
        .with_devtools(true)
        .build(&window)?;

    // Polled on a thread so the window paints while the services come up. The
    // supervisor publishes what it is doing; waiting on that rather than on
    // the panel's port alone is what lets the loading screen name the service
    // still being waited for, and know which ones were skipped.
    // The event loop takes ownership of everything it touches, so the paths it
    // still needs are cloned out before the closure captures them.
    let geometry_root = root.clone();
    let status_file = root.join("var").join("run").join("status.json");
    // Nothing was spawned, so nothing is going to publish progress: the
    // services were already running and were adopted.
    let adopted = child.is_none();
    std::thread::spawn(move || {
        if adopted {
            let _ = proxy.send_event(UserEvent::Ready);
            return;
        }
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = String::new();
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&status_file) {
                if text != last {
                    last = text.clone();
                    let _ = proxy.send_event(UserEvent::Progress(text.clone()));
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("done").and_then(|v| v.as_bool()) == Some(true) {
                        // Startup finished. Whether every optional service made
                        // it is the panel's business to show; the window opens
                        // either way, as long as the panel is actually serving.
                        if port_open(PANEL_PORT) {
                            let _ = proxy.send_event(UserEvent::Ready);
                        } else {
                            let _ = proxy.send_event(UserEvent::Failed);
                        }
                        return;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(400));
        }
        let _ = proxy.send_event(UserEvent::Failed);
    });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Progress(payload)) => {
                let _ = webview.evaluate_script(&format!(
                    "window.setProgress && window.setProgress({payload})"
                ));
            }
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
                    &labels,
                );
                let _ = webview.load_html(&html);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // Read before anything is torn down, while the window still
                // has a size to report.
                save_geometry(&geometry_root, &window);
                if let Some(child) = child.as_mut() {
                    stop_supervisor(child);
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
