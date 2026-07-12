use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

// Builds the native application menu. Custom items carry ids that are forwarded
// to the frontend via the `menu-action` event (see lib.rs `on_menu_event`);
// predefined items (copy/paste/quit/…) are handled by the OS.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "Maincode")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_file = MenuItemBuilder::with_id("new-file", "New File")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_all = MenuItemBuilder::with_id("save-all", "Save All")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let close_editor = MenuItemBuilder::with_id("close-editor", "Close Editor")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_folder = MenuItemBuilder::with_id("close-folder", "Close Folder").build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&open_folder)
        .separator()
        .item(&save)
        .item(&save_all)
        .separator()
        .item(&close_editor)
        .item(&close_folder)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let search_files = MenuItemBuilder::with_id("search-files", "Search Files…")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    let toggle_terminal = MenuItemBuilder::with_id("toggle-terminal", "Toggle Terminal")
        .accelerator("Ctrl+`")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&command_palette)
        .item(&search_files)
        .separator()
        .item(&toggle_terminal)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .fullscreen()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}
