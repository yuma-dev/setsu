//! Global hotkey listener that works inside games. Switched from
//! `RegisterHotKey` (`WM_HOTKEY` gets swallowed by fullscreen games grabbing
//! input, e.g. League of Legends) to Raw Input + `RIDEV_INPUTSINK`.

use anyhow::{anyhow, Context, Result};
use crossbeam_channel::{Receiver, Sender};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tracing::info;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    PostThreadMessageW, RegisterClassExW, TranslateMessage, HMENU, HWND_MESSAGE, MSG,
    RI_KEY_BREAK, RI_KEY_E0, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WM_QUIT, WNDCLASSEXW,
};

/// mirrors `MOD_*` from `winuser.h`, kept for parsing even though we no
/// longer call `RegisterHotKey`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Modifiers(pub u32);

impl Modifiers {
    pub const ALT: Self = Self(0x0001);
    pub const CONTROL: Self = Self(0x0002);
    pub const SHIFT: Self = Self(0x0004);
    pub const WIN: Self = Self(0x0008);

    pub fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }
}

impl std::ops::BitOr for Modifiers {
    type Output = Self;
    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HotkeyBinding {
    pub modifiers: Modifiers,
    /// Windows `VK_*` virtual-key code.
    pub vk: u32,
}

impl HotkeyBinding {
    /// parses shortcuts like `"Ctrl+Shift+S"` or `"Alt+F9"`, case-insensitive
    /// `+`-separated
    ///
    /// Supported tokens:
    /// - Modifiers: `ctrl`/`control`, `shift`, `alt`, `win`/`super`
    /// - Letters: `a`-`z` (single ASCII char)
    /// - Digits: `0`-`9`
    /// - Function keys: `f1`-`f24`
    /// - Named keys: `space`, `tab`, `enter`, `backspace`, `escape`
    ///   `insert`, `delete`, `home`, `end`, `pageup`, `pagedown`
    ///   arrows (`up`/`down`/`left`/`right`), `printscreen`
    ///   `scrolllock`, `pause`, `capslock`, `numlock`
    /// - Numpad: `num0`-`num9`, `numplus`, `numminus`, `nummult`
    ///   `numdiv`, `numdot`
    /// - Punctuation: `` ; = , - . / ` [ \ ] ' ``
    ///
    /// exactly one non-modifier key token required, taken as the key
    pub fn parse(s: &str) -> Result<Self> {
        let mut modifiers = Modifiers::default();
        let mut vk: Option<u32> = None;
        for raw in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
            let lower = raw.to_ascii_lowercase();
            match lower.as_str() {
                "ctrl" | "control" => modifiers = modifiers | Modifiers::CONTROL,
                "shift" => modifiers = modifiers | Modifiers::SHIFT,
                "alt" => modifiers = modifiers | Modifiers::ALT,
                "win" | "super" | "meta" => modifiers = modifiers | Modifiers::WIN,
                key => {
                    let code = parse_vk(key)
                        .with_context(|| format!("unknown hotkey token '{raw}' in '{s}'"))?;
                    if vk.is_some() {
                        return Err(anyhow!(
                            "hotkey '{s}' has multiple non-modifier keys; only one is allowed"
                        ));
                    }
                    vk = Some(code);
                }
            }
        }
        Ok(Self {
            modifiers,
            vk: vk.ok_or_else(|| anyhow!("hotkey '{s}' has no key (only modifiers)"))?,
        })
    }
}

/// parses a single non-modifier key token into a Windows VK code
fn parse_vk(key: &str) -> Result<u32> {
    if key.len() == 1 {
        let c = key.chars().next().unwrap().to_ascii_uppercase();
        if c.is_ascii_alphabetic() || c.is_ascii_digit() {
            return Ok(c as u32);
        }
        // OEM punctuation keys (US layout positions)
        let vk = match c {
            ';' => 0xBA, // VK_OEM_1
            '=' => 0xBB, // VK_OEM_PLUS
            ',' => 0xBC, // VK_OEM_COMMA
            '-' => 0xBD, // VK_OEM_MINUS
            '.' => 0xBE, // VK_OEM_PERIOD
            '/' => 0xBF, // VK_OEM_2
            '`' => 0xC0, // VK_OEM_3
            '[' => 0xDB, // VK_OEM_4
            '\\' => 0xDC, // VK_OEM_5
            ']' => 0xDD, // VK_OEM_6
            '\'' => 0xDE, // VK_OEM_7
            _ => 0,
        };
        if vk != 0 {
            return Ok(vk);
        }
    }
    if let Some(n_str) = key.strip_prefix('f') {
        if let Ok(n) = n_str.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Ok(0x70 + (n - 1));
            }
        }
    }
    // numpad: num0-num9 plus the operator keys
    if let Some(n_str) = key.strip_prefix("num") {
        if let Ok(n) = n_str.parse::<u32>() {
            if n <= 9 {
                return Ok(0x60 + n); // VK_NUMPAD0..9
            }
        }
        let vk = match n_str {
            "plus" => 0x6B,  // VK_ADD
            "minus" => 0x6D, // VK_SUBTRACT
            "mult" => 0x6A,  // VK_MULTIPLY
            "div" => 0x6F,   // VK_DIVIDE
            "dot" => 0x6E,   // VK_DECIMAL
            "lock" => 0x90,  // VK_NUMLOCK
            _ => 0,
        };
        if vk != 0 {
            return Ok(vk);
        }
    }
    // named keys
    let vk = match key {
        "space" => 0x20,
        "tab" => 0x09,
        "enter" | "return" => 0x0D,
        "backspace" => 0x08,
        "escape" | "esc" => 0x1B,
        "insert" | "ins" => 0x2D,
        "delete" | "del" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" | "arrowup" => 0x26,
        "down" | "arrowdown" => 0x28,
        "left" | "arrowleft" => 0x25,
        "right" | "arrowright" => 0x27,
        "printscreen" | "prtsc" => 0x2C,
        "scrolllock" => 0x91,
        "pause" => 0x13,
        "capslock" => 0x14,
        _ => 0,
    };
    if vk != 0 {
        return Ok(vk);
    }
    Err(anyhow!(
        "unsupported key '{key}' — use a letter, digit, F1–F24, numpad key, or a named key like Space / PageUp / Up"
    ))
}

/// modifier keys by side, so AltGr (LCtrl+RAlt) and a stuck key show up in logs
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Held(pub u8);

const L_CTRL: u8 = 1 << 0;
const R_CTRL: u8 = 1 << 1;
const L_ALT: u8 = 1 << 2;
const R_ALT: u8 = 1 << 3;
const L_SHIFT: u8 = 1 << 4;
const R_SHIFT: u8 = 1 << 5;
const L_WIN: u8 = 1 << 6;
const R_WIN: u8 = 1 << 7;
const SIDE_NAMES: [&str; 8] = ["LCtrl", "RCtrl", "LAlt", "RAlt", "LShift", "RShift", "LWin", "RWin"];

impl Held {
    /// sides folded into `MOD_*` bits, what bindings match against
    pub fn modifiers(self) -> Modifiers {
        let mut m = 0;
        if self.0 & (L_CTRL | R_CTRL) != 0 {
            m |= Modifiers::CONTROL.0;
        }
        if self.0 & (L_ALT | R_ALT) != 0 {
            m |= Modifiers::ALT.0;
        }
        if self.0 & (L_SHIFT | R_SHIFT) != 0 {
            m |= Modifiers::SHIFT.0;
        }
        if self.0 & (L_WIN | R_WIN) != 0 {
            m |= Modifiers::WIN.0;
        }
        Modifiers(m)
    }
}

impl std::fmt::Display for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0 == 0 {
            return f.write_str("none");
        }
        let mut first = true;
        for (i, name) in SIDE_NAMES.iter().enumerate() {
            if self.0 & (1 << i) != 0 {
                if !first {
                    f.write_str("+")?;
                }
                f.write_str(name)?;
                first = false;
            }
        }
        Ok(())
    }
}

/// `MOD_*` bit for one side bit
fn side_modifier(side: u8) -> u32 {
    match side {
        L_CTRL | R_CTRL => Modifiers::CONTROL.0,
        L_ALT | R_ALT => Modifiers::ALT.0,
        L_SHIFT | R_SHIFT => Modifiers::SHIFT.0,
        _ => Modifiers::WIN.0,
    }
}

/// raw input reports generic VK_CONTROL/VK_MENU/VK_SHIFT, the side is in the E0 flag
/// (ctrl, alt) or the scan code (shift, 0x36 is right)
fn modifier_side(vk: u32, make_code: u16, e0: bool) -> Option<u8> {
    Some(match vk {
        0xA2 => L_CTRL,
        0xA3 => R_CTRL,
        0x11 if e0 => R_CTRL,
        0x11 => L_CTRL,
        0xA4 => L_ALT,
        0xA5 => R_ALT,
        0x12 if e0 => R_ALT,
        0x12 => L_ALT,
        0xA0 => L_SHIFT,
        0xA1 => R_SHIFT,
        0x10 if make_code == 0x36 => R_SHIFT,
        0x10 => L_SHIFT,
        0x5B => L_WIN,
        0x5C => R_WIN,
        _ => return None,
    })
}

/// a hotkey press that matched
#[derive(Clone, Copy, Debug)]
pub struct Press {
    pub held: Held,
    /// fired on a key-up whose down never arrived
    pub orphan: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NearMissReason {
    /// all wanted modifiers plus more, e.g. ctrl held for crouch, or AltGr (LCtrl+RAlt) for Alt
    ExtraModifiers,
    /// only some of the wanted modifiers
    MissingModifiers,
    /// key went down first, the modifier followed while it was still held
    KeyBeforeModifier,
    /// the modifier came up just before the key went down
    ModifierReleasedEarly,
}

impl NearMissReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExtraModifiers => "extra_modifiers",
            Self::MissingModifiers => "missing_modifiers",
            Self::KeyBeforeModifier => "key_before_modifier",
            Self::ModifierReleasedEarly => "modifier_released_early",
        }
    }
}

/// a press of a bound key that looked like an attempt at the hotkey but didn't fire
#[derive(Clone, Copy, Debug)]
pub struct NearMiss {
    /// index into the bindings given to `spawn`
    pub binding: usize,
    pub reason: NearMissReason,
    /// the gap for the two timing reasons, how long the extras were down for ExtraModifiers
    pub ms: u64,
    pub held: Held,
}

/// a modifier this close to the key counts as a fumbled chord
const CHORD_WINDOW: Duration = Duration::from_millis(300);

/// handle to the message-pump thread; drop to stop the listener
pub struct HotkeyListener {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl HotkeyListener {
    /// spawns one thread listening for all given bindings, returning one
    /// `Receiver<Press>` per binding (fires on key down-transition, no repeat) plus one
    /// for near misses. Only one Raw Input registration exists per process: a second
    /// `RegisterRawInputDevices` call for the same device type would replace the first.
    ///
    /// nothing here logs keys. INPUTSINK sees everything typed in any app and the log
    /// goes up with error events, so only hotkey outcomes leave this crate
    pub fn spawn(
        bindings: &[HotkeyBinding],
    ) -> Result<(Self, Vec<Receiver<Press>>, Receiver<NearMiss>)> {
        assert!(!bindings.is_empty(), "need at least one binding");

        let (press_txs, press_rxs): (Vec<_>, Vec<_>) = bindings
            .iter()
            .map(|_| crossbeam_channel::unbounded::<Press>())
            .unzip();
        let (near_tx, near_rx) = crossbeam_channel::unbounded::<NearMiss>();

        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<u32>>(1);
        let bindings = bindings.to_vec();

        let join = std::thread::Builder::new()
            .name("clipdip-hotkey".into())
            .spawn(move || run_thread(bindings, press_txs, near_tx, ready_tx))
            .context("spawn hotkey thread")?;

        let thread_id = ready_rx
            .recv()
            .context("hotkey thread died before reporting status")??;

        Ok((
            Self {
                thread_id,
                join: Some(join),
            },
            press_rxs,
            near_rx,
        ))
    }
}

impl Drop for HotkeyListener {
    fn drop(&mut self) {
        // WM_QUIT makes GetMessage return zero so the thread exits cleanly
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

// thread-local listener state

struct ListenerState {
    bindings: Vec<HotkeyBinding>,
    /// per-binding: whether the non-modifier key is held, to suppress
    /// OS auto-repeat
    key_pressed: Vec<bool>,
    /// per-binding: its key went down with none of the wanted modifiers, to catch one
    /// landing right after
    missed_at: Vec<Option<Instant>>,
    press_txs: Vec<Sender<Press>>,
    near_tx: Sender<NearMiss>,
    held: Held,
    /// per side bit
    down_at: [Option<Instant>; 8],
    /// per `MOD_*` bit position, last time neither side was held
    up_at: [Option<Instant>; 4],
    started: Instant,
}

/// a key held while the listener (re)starts, e.g. while rebinding it in settings,
/// releases as an orphan up; don't treat that as a press
const ORPHAN_UP_GRACE: Duration = Duration::from_secs(2);

impl ListenerState {
    fn new(
        bindings: Vec<HotkeyBinding>,
        press_txs: Vec<Sender<Press>>,
        near_tx: Sender<NearMiss>,
        started: Instant,
    ) -> Self {
        let n = bindings.len();
        Self {
            bindings,
            key_pressed: vec![false; n],
            missed_at: vec![None; n],
            press_txs,
            near_tx,
            held: Held::default(),
            down_at: [None; 8],
            up_at: [None; 4],
            started,
        }
    }

    fn on_modifier(&mut self, side: u8, is_down: bool, now: Instant) {
        let idx = side.trailing_zeros() as usize;
        let bit = side_modifier(side);
        if !is_down {
            self.held.0 &= !side;
            self.down_at[idx] = None;
            if self.held.modifiers().0 & bit == 0 {
                self.up_at[bit.trailing_zeros() as usize] = Some(now);
            }
            return;
        }
        // auto-repeat
        if self.held.0 & side != 0 {
            return;
        }
        self.held.0 |= side;
        self.down_at[idx] = Some(now);
        if bit == Modifiers::SHIFT.0 {
            return;
        }
        for i in 0..self.bindings.len() {
            let Some(at) = self.missed_at[i] else { continue };
            if !self.key_pressed[i] || self.bindings[i].modifiers.0 & bit == 0 {
                continue;
            }
            self.missed_at[i] = None;
            let gap = now.duration_since(at);
            if gap <= CHORD_WINDOW {
                self.near_miss(i, NearMissReason::KeyBeforeModifier, gap.as_millis() as u64);
                return;
            }
        }
    }

    fn on_key(&mut self, vk: u32, is_down: bool, now: Instant) {
        let Some(first) = self.bindings.iter().position(|b| b.vk == vk) else {
            return;
        };
        // bindings on the same key share one physical key state
        let was_down = self.key_pressed[first];
        for i in 0..self.bindings.len() {
            if self.bindings[i].vk == vk {
                self.key_pressed[i] = is_down;
                if !is_down {
                    self.missed_at[i] = None;
                }
            }
        }
        // auto-repeat, or the up after a normal down
        if was_down {
            return;
        }
        if !is_down {
            // up with no down: something upstream ate the down (another app's
            // low-level hook bound to the same key). seen in the wild with F8
            if now.duration_since(self.started) >= ORPHAN_UP_GRACE {
                self.fire(vk, true);
            }
            return;
        }
        if self.fire(vk, false) {
            return;
        }
        let held = self.held.modifiers().0;
        for i in 0..self.bindings.len() {
            let want = self.bindings[i].modifiers.0;
            if self.bindings[i].vk != vk {
                continue;
            }
            match classify_miss(want, held, self.released_ms_ago(now)) {
                Miss::Ignore => {}
                Miss::Watch => self.missed_at[i] = Some(now),
                Miss::Reason(reason, ms) => {
                    let ms = if reason == NearMissReason::ExtraModifiers {
                        self.extras_held_ms(want, now)
                    } else {
                        ms
                    };
                    self.near_miss(i, reason, ms);
                    return;
                }
            }
        }
    }

    /// sends a press to every binding on `vk` whose modifiers match exactly
    fn fire(&self, vk: u32, orphan: bool) -> bool {
        let held = self.held.modifiers().0;
        let mut fired = false;
        for (b, tx) in self.bindings.iter().zip(&self.press_txs) {
            if b.vk == vk && b.modifiers.0 == held {
                let _ = tx.send(Press {
                    held: self.held,
                    orphan,
                });
                fired = true;
            }
        }
        fired
    }

    fn near_miss(&self, binding: usize, reason: NearMissReason, ms: u64) {
        let _ = self.near_tx.send(NearMiss {
            binding,
            reason,
            ms,
            held: self.held,
        });
    }

    fn released_ms_ago(&self, now: Instant) -> [Option<u64>; 4] {
        self.up_at
            .map(|t| t.map(|t| now.duration_since(t).as_millis() as u64))
    }

    /// longest hold among held modifiers the binding doesn't want, a stuck key shows as
    /// a huge number
    fn extras_held_ms(&self, want: u32, now: Instant) -> u64 {
        (0..8usize)
            .filter(|&i| self.held.0 & (1 << i) != 0 && side_modifier(1 << i) & want == 0)
            .filter_map(|i| self.down_at[i])
            .map(|t| now.duration_since(t).as_millis() as u64)
            .max()
            .unwrap_or(0)
    }
}

enum Miss {
    Ignore,
    /// none of the wanted modifiers yet, watch for one landing right after
    Watch,
    Reason(NearMissReason, u64),
}

/// whether a bound key going down with the wrong modifiers was probably an attempt.
/// shift alone never counts, a capital letter while typing would look like one
fn classify_miss(want: u32, held: u32, released_ms_ago: [Option<u64>; 4]) -> Miss {
    let attempt = want & !Modifiers::SHIFT.0;
    if attempt == 0 || held == want {
        return Miss::Ignore;
    }
    let missing = want & !held;
    for (bit, released) in released_ms_ago.iter().enumerate() {
        if missing & attempt & (1 << bit) == 0 {
            continue;
        }
        if let Some(ms) = *released {
            if ms <= CHORD_WINDOW.as_millis() as u64 {
                return Miss::Reason(NearMissReason::ModifierReleasedEarly, ms);
            }
        }
    }
    if held & attempt == 0 {
        return Miss::Watch;
    }
    let reason = if missing == 0 {
        NearMissReason::ExtraModifiers
    } else {
        NearMissReason::MissingModifiers
    };
    Miss::Reason(reason, 0)
}

thread_local! {
    static LISTENER: RefCell<Option<ListenerState>> = const { RefCell::new(None) };
}

/// lazily registers the window class once per process
fn window_class_name() -> PCWSTR {
    static CLASS: OnceLock<Vec<u16>> = OnceLock::new();
    let buf = CLASS.get_or_init(|| {
        let name: Vec<u16> = "clipdip_hotkey_window\0".encode_utf16().collect();
        static REGISTERED: AtomicU32 = AtomicU32::new(0);
        if REGISTERED.swap(1, Ordering::SeqCst) == 0 {
            unsafe {
                let hinst = GetModuleHandleW(None).unwrap_or_default();
                let mut wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: HINSTANCE(hinst.0),
                    lpszClassName: PCWSTR(name.as_ptr()),
                    ..Default::default()
                };
                let _ = RegisterClassExW(&mut wc);
            }
        }
        name
    });
    PCWSTR(buf.as_ptr())
}

fn run_thread(
    bindings: Vec<HotkeyBinding>,
    press_txs: Vec<Sender<Press>>,
    near_tx: Sender<NearMiss>,
    ready_tx: Sender<Result<u32>>,
) {
    let n = bindings.len();
    LISTENER.with(|cell| {
        *cell.borrow_mut() = Some(ListenerState::new(
            bindings,
            press_txs,
            near_tx,
            Instant::now(),
        ));
    });

    let class_name = window_class_name();

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            HMENU::default(),
            HINSTANCE::default(),
            None,
        )
    };
    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("CreateWindowExW failed: {e}")));
            return;
        }
    };

    let device = RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0x06,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    };
    if let Err(e) = unsafe {
        RegisterRawInputDevices(&[device], std::mem::size_of::<RAWINPUTDEVICE>() as u32)
    } {
        unsafe { let _ = DestroyWindow(hwnd); }
        let _ = ready_tx.send(Err(anyhow!("RegisterRawInputDevices failed: {e}")));
        return;
    }

    let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    info!(
        "hotkey listener ready — {} binding(s), thread={}",
        n, thread_id
    );
    if ready_tx.send(Ok(thread_id)).is_err() {
        unsafe { let _ = DestroyWindow(hwnd); }
        return;
    }

    let mut msg = MSG::default();
    loop {
        let res = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if res.0 <= 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe {
        let _ = DestroyWindow(hwnd);
    }
    LISTENER.with(|cell| *cell.borrow_mut() = None);
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        unsafe { handle_raw_input(HRAWINPUT(lparam.0 as *mut _)) };
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe fn handle_raw_input(h_raw_input: HRAWINPUT) {
    let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;

    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let mut buf = vec![0u8; size as usize];

    let read = GetRawInputData(
        h_raw_input,
        RID_INPUT,
        Some(buf.as_mut_ptr() as *mut _),
        &mut size,
        header_size,
    );
    if read == u32::MAX {
        return;
    }
    if read == 0 && size > buf.len() as u32 {
        buf.resize(size as usize, 0);
        let read = GetRawInputData(
            h_raw_input,
            RID_INPUT,
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            header_size,
        );
        if read == u32::MAX || read == 0 {
            return;
        }
    }

    let raw = &*(buf.as_ptr() as *const RAWINPUT);
    if raw.header.dwType != RIM_TYPEKEYBOARD.0 {
        return;
    }
    let kb = &raw.data.keyboard;
    let vk = kb.VKey as u32;
    let flags = kb.Flags as u32;
    let is_down = flags & RI_KEY_BREAK == 0;
    let e0 = flags & RI_KEY_E0 != 0;
    // E0 shift is the fake one windows wraps around nav keys while numlock is on
    if vk == 0x10 && e0 {
        return;
    }
    let now = Instant::now();

    LISTENER.with(|cell| {
        let mut state_ref = cell.borrow_mut();
        let Some(state) = state_ref.as_mut() else {
            return;
        };
        match modifier_side(vk, kb.MakeCode, e0) {
            Some(side) => state.on_modifier(side, is_down, now),
            None => state.on_key(vk, is_down, now),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_compose() {
        let m = Modifiers::CONTROL | Modifiers::SHIFT;
        assert!(m.contains(Modifiers::CONTROL));
        assert!(m.contains(Modifiers::SHIFT));
        assert!(!m.contains(Modifiers::ALT));
    }

    #[test]
    fn parse_basic_letter_hotkey() {
        let b = HotkeyBinding::parse("Ctrl+Shift+S").unwrap();
        assert!(b.modifiers.contains(Modifiers::CONTROL));
        assert!(b.modifiers.contains(Modifiers::SHIFT));
        assert!(!b.modifiers.contains(Modifiers::ALT));
        assert_eq!(b.vk, 'S' as u32);
    }

    #[test]
    fn parse_is_case_insensitive() {
        let b = HotkeyBinding::parse("alt+f9").unwrap();
        assert!(b.modifiers.contains(Modifiers::ALT));
        assert_eq!(b.vk, 0x78); // VK_F9 = 0x70 + 8
    }

    #[test]
    fn parse_digit_key() {
        let b = HotkeyBinding::parse("Win+3").unwrap();
        assert!(b.modifiers.contains(Modifiers::WIN));
        assert_eq!(b.vk, '3' as u32);
    }

    #[test]
    fn parse_rejects_no_key() {
        assert!(HotkeyBinding::parse("Ctrl+Shift").is_err());
    }

    #[test]
    fn parse_rejects_multiple_keys() {
        assert!(HotkeyBinding::parse("Ctrl+S+T").is_err());
    }

    #[test]
    fn parse_rejects_unknown_token() {
        assert!(HotkeyBinding::parse("Ctrl+Banana").is_err());
    }

    #[test]
    fn parse_bare_function_key() {
        let b = HotkeyBinding::parse("F15").unwrap();
        assert_eq!(b.modifiers.0, 0);
        assert_eq!(b.vk, 0x7E); // VK_F15 = 0x70 + 14
    }

    #[test]
    fn parse_named_keys() {
        assert_eq!(HotkeyBinding::parse("Ctrl+Space").unwrap().vk, 0x20);
        assert_eq!(HotkeyBinding::parse("Alt+PageUp").unwrap().vk, 0x21);
        assert_eq!(HotkeyBinding::parse("Shift+Up").unwrap().vk, 0x26);
        assert_eq!(HotkeyBinding::parse("Ctrl+Delete").unwrap().vk, 0x2E);
        assert_eq!(HotkeyBinding::parse("Pause").unwrap().vk, 0x13);
    }

    #[test]
    fn parse_numpad_keys() {
        assert_eq!(HotkeyBinding::parse("Ctrl+Num5").unwrap().vk, 0x65);
        assert_eq!(HotkeyBinding::parse("NumPlus").unwrap().vk, 0x6B);
        assert_eq!(HotkeyBinding::parse("Alt+NumDot").unwrap().vk, 0x6E);
    }

    #[test]
    fn parse_punctuation_keys() {
        assert_eq!(HotkeyBinding::parse("Ctrl+;").unwrap().vk, 0xBA);
        assert_eq!(HotkeyBinding::parse("Ctrl+/").unwrap().vk, 0xBF);
        assert_eq!(HotkeyBinding::parse("Ctrl+`").unwrap().vk, 0xC0);
        assert_eq!(HotkeyBinding::parse("Ctrl+-").unwrap().vk, 0xBD);
        assert_eq!(HotkeyBinding::parse("Ctrl+[").unwrap().vk, 0xDB);
    }

    struct Rig {
        state: ListenerState,
        presses: Vec<Receiver<Press>>,
        misses: Receiver<NearMiss>,
        t0: Instant,
    }

    impl Rig {
        fn new(specs: &[&str]) -> Self {
            let bindings: Vec<_> = specs.iter().map(|s| HotkeyBinding::parse(s).unwrap()).collect();
            let (txs, presses): (Vec<_>, Vec<_>) =
                bindings.iter().map(|_| crossbeam_channel::unbounded()).unzip();
            let (near_tx, misses) = crossbeam_channel::unbounded();
            let t0 = Instant::now();
            Self {
                state: ListenerState::new(bindings, txs, near_tx, t0),
                presses,
                misses,
                t0,
            }
        }
        fn at(&self, ms: u64) -> Instant {
            self.t0 + Duration::from_millis(ms)
        }
        fn mod_(&mut self, side: u8, down: bool, ms: u64) {
            let now = self.at(ms);
            self.state.on_modifier(side, down, now);
        }
        fn key(&mut self, c: char, down: bool, ms: u64) {
            let now = self.at(ms);
            self.state.on_key(c as u32, down, now);
        }
        fn presses(&self, i: usize) -> Vec<Press> {
            self.presses[i].try_iter().collect()
        }
        fn misses(&self) -> Vec<NearMiss> {
            self.misses.try_iter().collect()
        }
    }

    #[test]
    fn exact_chord_fires_once() {
        let mut r = Rig::new(&["Alt+X"]);
        r.mod_(L_ALT, true, 0);
        r.key('X', true, 50);
        r.key('X', true, 80);
        r.key('X', true, 110);
        let p = r.presses(0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].held.to_string(), "LAlt");
        assert!(r.misses().is_empty());
    }

    #[test]
    fn sprinting_is_extra_modifiers() {
        let mut r = Rig::new(&["Alt+X"]);
        r.mod_(L_SHIFT, true, 0);
        r.mod_(L_ALT, true, 900);
        r.key('X', true, 1000);
        assert!(r.presses(0).is_empty());
        let m = r.misses();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].reason, NearMissReason::ExtraModifiers);
        assert_eq!(m[0].ms, 1000);
        assert_eq!(m[0].held.to_string(), "LAlt+LShift");
    }

    #[test]
    fn altgr_shows_as_ctrl_and_right_alt() {
        let mut r = Rig::new(&["Alt+X"]);
        r.mod_(modifier_side(0x11, 0x1D, false).unwrap(), true, 0);
        r.mod_(modifier_side(0x12, 0x38, true).unwrap(), true, 0);
        r.key('X', true, 40);
        let m = r.misses();
        assert_eq!(m[0].reason, NearMissReason::ExtraModifiers);
        assert_eq!(m[0].held.to_string(), "LCtrl+RAlt");
    }

    #[test]
    fn key_before_modifier() {
        let mut r = Rig::new(&["Alt+X"]);
        r.key('X', true, 0);
        r.mod_(L_ALT, true, 40);
        assert!(r.presses(0).is_empty());
        let m = r.misses();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].reason, NearMissReason::KeyBeforeModifier);
        assert_eq!(m[0].ms, 40);
    }

    #[test]
    fn modifier_released_early() {
        let mut r = Rig::new(&["Alt+X"]);
        r.mod_(L_ALT, true, 0);
        r.mod_(L_ALT, false, 100);
        r.key('X', true, 150);
        let m = r.misses();
        assert_eq!(m[0].reason, NearMissReason::ModifierReleasedEarly);
        assert_eq!(m[0].ms, 50);
    }

    #[test]
    fn missing_modifiers() {
        let mut r = Rig::new(&["Ctrl+Alt+X"]);
        r.mod_(L_ALT, true, 0);
        r.key('X', true, 50);
        assert_eq!(r.misses()[0].reason, NearMissReason::MissingModifiers);
    }

    #[test]
    fn typing_is_never_a_near_miss() {
        let mut r = Rig::new(&["Alt+X", "Ctrl+Shift+S"]);
        // x, X, s, S, then a modifier long after
        r.key('X', true, 0);
        r.key('X', false, 60);
        r.mod_(L_SHIFT, true, 100);
        r.key('X', true, 150);
        r.key('X', false, 200);
        r.key('S', true, 250);
        r.key('S', false, 300);
        r.mod_(L_SHIFT, false, 350);
        r.key('S', true, 400);
        r.key('S', false, 450);
        r.mod_(L_ALT, true, 2000);
        assert!(r.misses().is_empty());
        assert!(r.presses(0).is_empty());
        assert!(r.presses(1).is_empty());
    }

    #[test]
    fn stuck_modifier_shows_its_hold_time() {
        let mut r = Rig::new(&["Alt+X"]);
        r.mod_(L_CTRL, true, 0);
        r.mod_(L_ALT, true, 60_000);
        r.key('X', true, 60_050);
        let m = r.misses();
        assert_eq!(m[0].reason, NearMissReason::ExtraModifiers);
        assert_eq!(m[0].ms, 60_050);
    }

    #[test]
    fn one_side_up_keeps_the_modifier() {
        let mut r = Rig::new(&["Shift+F5"]);
        r.mod_(L_SHIFT, true, 0);
        r.mod_(R_SHIFT, true, 10);
        r.mod_(R_SHIFT, false, 20);
        r.state.on_key(0x74, true, r.at(30));
        assert_eq!(r.presses(0).len(), 1);
    }

    #[test]
    fn orphan_up_fires_after_grace_only() {
        let mut r = Rig::new(&["Alt+X"]);
        r.mod_(L_ALT, true, 0);
        r.key('X', false, 500);
        assert!(r.presses(0).is_empty());
        r.key('X', false, 3000);
        let p = r.presses(0);
        assert_eq!(p.len(), 1);
        assert!(p[0].orphan);
    }

    #[test]
    fn modifier_sides_from_raw_input() {
        assert_eq!(modifier_side(0x10, 0x2A, false), Some(L_SHIFT));
        assert_eq!(modifier_side(0x10, 0x36, false), Some(R_SHIFT));
        assert_eq!(modifier_side(0x11, 0x1D, true), Some(R_CTRL));
        assert_eq!(modifier_side(0x12, 0x38, false), Some(L_ALT));
        assert_eq!(modifier_side(0x5C, 0x5C, true), Some(R_WIN));
        assert_eq!(modifier_side('X' as u32, 0x2D, false), None);
        assert_eq!(Held::default().to_string(), "none");
    }
}
