// Embeds the icon as a Windows resource, which is what gives the exe its
// picture in Explorer and on the taskbar. Setting it on the window at runtime
// would only cover the window.
fn main() {
    println!("cargo:rerun-if-changed=icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("icon.ico");
        if let Err(err) = resource.compile() {
            // A missing resource compiler should not stop the shell being
            // built; it just comes out with the default icon.
            println!("cargo:warning=could not embed the icon: {err}");
        }
    }
}
