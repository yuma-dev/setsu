fn main() {
    // launcher is what shortcuts/taskbar pins point at, carries the app icon
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../../icon.ico");
        // a bare version block is one more thing Defender's ML holds against an unsigned exe
        res.set("ProductName", "Setsu");
        res.set("FileDescription", "Setsu Launcher");
        res.set("CompanyName", "yuma-dev");
        res.set("LegalCopyright", "Copyright (c) 2026 yuma-dev");
        res.set("InternalName", "Setsu Launcher");
        res.set("OriginalFilename", "Setsu Launcher.exe");
        res.set_manifest(MANIFEST);
        // fail loudly: shortcuts/pins take their icon from this exe
        if let Err(error) = res.compile() {
            panic!("launcher icon resource not compiled (rc.exe from the Windows SDK is required): {error}");
        }
    }
    println!("cargo:rerun-if-changed=../../../icon.ico");
}

// per-monitor v2 like SetProcessDpiAwarenessContext in main, no elevation, Windows 10+
const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;
