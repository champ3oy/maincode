//! macOS Dock-menu "New Window" item.
//!
//! Tauri/tao expose no dock-menu API, so we hook AppKit's
//! `-[NSApplicationDelegate applicationDockMenu:]` ourselves. That method is
//! what macOS calls to build the menu shown when the user right-clicks the app's
//! Dock icon.
//!
//! Strategy (see task brief, "Strategy A"): we do NOT replace tao's live app
//! delegate — doing so would break the window/app lifecycle it drives. Instead,
//! at startup (on the main thread) we take the delegate that tao already
//! installed and *add* an `applicationDockMenu:` method to its class via the
//! Objective-C runtime (`class_addMethod`). tao's delegate does not implement
//! that selector, so there is no conflict, and the rest of the delegate's
//! behaviour is untouched.
//!
//! The menu contains one item, "New Window", whose action routes back into Rust
//! and calls the same [`crate::menu::open_new_window`] used by `File → New
//! Window`. The action's target is a small `NSObject` subclass we define and
//! keep alive for the whole process (a menu item stores its target *unretained*,
//! so it must not be dropped).

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{define_class, ffi, msg_send, sel};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::{MainThreadMarker, NSString};
use tauri::Manager;

/// The Tauri app handle, needed to open new windows from the Dock-menu action.
/// Set once during [`install`].
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// The action target for the Dock menu item. A menu item holds its target
/// *unretained*, so we must keep this object alive for the whole process.
static DOCK_TARGET: OnceLock<Retained<DockMenuTarget>> = OnceLock::new();

define_class!(
    // SAFETY:
    // - The superclass NSObject has no subclassing requirements.
    // - `DockMenuTarget` does not implement `Drop`.
    #[unsafe(super(objc2::runtime::NSObject))]
    #[name = "MaincodeDockMenuTarget"]
    struct DockMenuTarget;

    impl DockMenuTarget {
        /// Action fired when the Dock-menu "New Window" item is clicked.
        /// Runs on the main thread (AppKit dispatches menu actions there).
        #[unsafe(method(newWindowFromDock:))]
        fn new_window_from_dock(&self, _sender: Option<&AnyObject>) {
            if let Some(app) = APP_HANDLE.get() {
                if let Err(e) = crate::menu::open_new_window(app) {
                    eprintln!("[maincode] dock menu: failed to open new window: {e}");
                }
            }
        }

        /// Action fired when one of the per-window Dock-menu items is clicked.
        /// The clicked `NSMenuItem` carries the target window's Tauri label in
        /// its `representedObject`; we read it back and focus that window.
        /// Runs on the main thread (AppKit dispatches menu actions there).
        #[unsafe(method(focusWindowFromDock:))]
        fn focus_window_from_dock(&self, sender: Option<&AnyObject>) {
            // The sender is the clicked NSMenuItem. Its `representedObject` was
            // set (in `build_dock_menu`) to an NSString holding the window's
            // Tauri label. `downcast_ref` is a runtime-checked cast, so a wrong
            // class (or None) simply yields `None` — no unsafe is required.
            let Some(item) = sender.and_then(|s| s.downcast_ref::<NSMenuItem>()) else {
                return;
            };
            let Some(represented) = item.representedObject() else {
                return;
            };
            let Some(label_ns) = represented.downcast_ref::<NSString>() else {
                return;
            };
            let label = label_ns.to_string();

            if let Some(app) = APP_HANDLE.get() {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_focus();
                }
            }
        }
    }
);

impl DockMenuTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        // Unit ivars: `set_ivars(())` turns `Allocated` into the `PartialInit`
        // receiver that the generated `init` expects.
        let this = mtm.alloc::<Self>().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Sort key for window labels so the Dock list reads `main`, `w-1`, `w-2`, …,
/// `w-10` numerically — a plain string sort would order `w-10` before `w-2`.
fn window_sort_key(label: &str) -> (u8, u64) {
    if label == "main" {
        (0, 0)
    } else if let Some(n) = label.strip_prefix("w-").and_then(|s| s.parse::<u64>().ok()) {
        (1, n)
    } else {
        (2, 0)
    }
}

/// Build the Dock menu that AppKit will display. Called from the injected
/// `applicationDockMenu:` IMP below (main thread).
fn build_dock_menu(mtm: MainThreadMarker) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);

    let title = NSString::from_str("New Window");
    let empty_key = NSString::from_str("");
    // SAFETY: `newWindowFromDock:` is a valid selector implemented by
    // `DockMenuTarget`. `addItemWithTitle:action:keyEquivalent:` appends the
    // item and returns a +1 `Retained`; the menu keeps its own retain, so
    // dropping ours at end of scope is correct.
    let item = unsafe {
        menu.addItemWithTitle_action_keyEquivalent(&title, Some(sel!(newWindowFromDock:)), &empty_key)
    };

    // Point the item at our long-lived target object.
    if let Some(target) = DOCK_TARGET.get() {
        // SAFETY: the target outlives the menu item (stored in DOCK_TARGET for
        // the process lifetime); AppKit stores the target unretained.
        let target_obj: &AnyObject = target.as_ref();
        unsafe { item.setTarget(Some(target_obj)) };
    }

    // Below the "New Window" item, list every open editor window. Each entry is
    // labelled by the window's native title (set to the project folder name by
    // the frontend, defaulting to "Maincode"); clicking one focuses that
    // window via `focusWindowFromDock:`.
    if let Some(app) = APP_HANDLE.get() {
        let mut entries: Vec<(String, String)> = app
            .webview_windows()
            .iter()
            .map(|(label, w)| (label.clone(), w.title().unwrap_or_else(|_| label.clone())))
            .collect();
        if !entries.is_empty() {
            // Order by Tauri label: main first, then w-1, w-2, … numerically.
            entries.sort_by_key(|(label, _)| window_sort_key(label));

            let separator = NSMenuItem::separatorItem(mtm);
            menu.addItem(&separator);

            for (label, title) in entries {
                let title_ns = NSString::from_str(&title);
                // SAFETY: `focusWindowFromDock:` is a valid selector implemented
                // by `DockMenuTarget`. `addItemWithTitle:action:keyEquivalent:`
                // appends the item and returns a +1 `Retained`; the menu keeps
                // its own retain, so dropping ours at end of scope is correct.
                let win_item = unsafe {
                    menu.addItemWithTitle_action_keyEquivalent(
                        &title_ns,
                        Some(sel!(focusWindowFromDock:)),
                        &empty_key,
                    )
                };

                if let Some(target) = DOCK_TARGET.get() {
                    // SAFETY: the target outlives the menu item (stored in
                    // DOCK_TARGET for the process lifetime); AppKit stores the
                    // target unretained.
                    let target_obj: &AnyObject = target.as_ref();
                    unsafe { win_item.setTarget(Some(target_obj)) };
                }

                // Stash the window's Tauri label so `focusWindowFromDock:` can
                // read it back. The NSString is retained by the menu item.
                let label_ns = NSString::from_str(&label);
                // SAFETY: `label_ns` is an NSString (the type the action reads
                // back via `downcast_ref::<NSString>()`); the menu item retains
                // it, so it stays valid for the item's lifetime.
                unsafe { win_item.setRepresentedObject(Some(&label_ns)) };
            }
        }
    }

    menu
}

/// Objective-C IMP for `-[<delegate> applicationDockMenu:]`.
///
/// Signature must match `NSMenu* (id self, SEL _cmd, NSApplication* sender)`,
/// i.e. type-encoding `@@:@`. Returns an autoreleased (+0) menu, which is what
/// AppKit expects from this delegate method.
///
/// # Safety
/// Installed via `class_addMethod` with a matching `@@:@` encoding, so AppKit
/// calls it with the documented argument types on the main thread.
extern "C-unwind" fn application_dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut NSApplication,
) -> *mut NSMenu {
    // AppKit only calls this on the main thread.
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let menu = build_dock_menu(mtm);
    // Return +0 (autoreleased): hand ownership back to the autorelease pool so
    // the caller (AppKit) does not over-release. `Retained` is +1, so consume it
    // via `autorelease` and return the raw pointer.
    Retained::autorelease_ptr(menu)
}

/// Install the Dock-menu hook. Must be called on the main thread, after Tauri
/// has set up its `NSApplication` delegate (i.e. from the `.setup` hook).
pub fn install(app: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app.clone());

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[maincode] dock menu: install() not on main thread; skipping");
        return;
    };

    // Create and retain the single action-target object for the process.
    if DOCK_TARGET.get().is_none() {
        let _ = DOCK_TARGET.set(DockMenuTarget::new(mtm));
    }

    // Add `applicationDockMenu:` to the live app delegate's class.
    if let Err(msg) = add_dock_menu_method(mtm) {
        eprintln!("[maincode] dock menu: {msg}");
    }
}

/// Add the `applicationDockMenu:` method to the current app delegate's class.
fn add_dock_menu_method(mtm: MainThreadMarker) -> Result<(), String> {
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else {
        return Err("no NSApplication delegate installed yet".to_string());
    };

    // The class that actually backs the delegate at runtime (tao's, or
    // whatever Tauri installed on top of it).
    let delegate_obj: &AnyObject = delegate.as_ref();
    let class: &AnyClass = delegate_obj.class();

    let sel = sel!(applicationDockMenu:);

    // If the delegate class already implements this selector, don't touch it —
    // `class_addMethod` would fail and we'd risk shadowing existing behaviour.
    if class.instance_method(sel).is_some() {
        return Err(format!(
            "delegate class `{}` already implements applicationDockMenu:; leaving it alone",
            class.name().to_string_lossy()
        ));
    }

    // Objective-C type encoding for `NSMenu* (id, SEL, NSApplication*)`:
    //   `@`  -> object return (NSMenu*)
    //   `@`  -> self (id)
    //   `:`  -> _cmd (SEL)
    //   `@`  -> sender (NSApplication*)
    let types = c"@@:@";

    // `class_addMethod` wants a bare `Imp` (`unsafe extern "C-unwind" fn()`);
    // our typed IMP has a matching ABI, so transmute the pointer.
    let imp: objc2::runtime::Imp = unsafe {
        std::mem::transmute::<
            extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSApplication) -> *mut NSMenu,
            unsafe extern "C-unwind" fn(),
        >(application_dock_menu)
    };

    // `class_addMethod` mutates the class in place. We have a shared reference,
    // but the runtime call is the documented way to add a method to an existing
    // class; there is a single delegate instance so there is no aliasing hazard.
    let cls_ptr = (class as *const AnyClass) as *mut AnyClass;
    // SAFETY: `sel` has 2 implicit args (self, _cmd) plus one declared arg,
    // matching both `types` and `imp`'s signature; `types` is a valid encoding
    // C string; `imp` is a valid IMP with that ABI.
    let ok = unsafe { ffi::class_addMethod(cls_ptr, sel, imp, types.as_ptr()) };
    if !ok.as_bool() {
        return Err(format!(
            "class_addMethod(applicationDockMenu:) failed on `{}`",
            class.name().to_string_lossy()
        ));
    }

    Ok(())
}
