use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Window, WindowEvent,
};

const TRAY_ID: &str = "main-tray";
const MAIN_WINDOW: &str = "main";
const SHOW_WINDOW: &str = "tray-show-window";
const QUIT: &str = "tray-quit";

pub(crate) fn init(app: &App) {
    if let Err(error) = create_tray(app) {
        eprintln!("Failed to initialize the system tray: {error}");
    }
}

fn create_tray(app: &App) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;
    let show = MenuItem::with_id(app, SHOW_WINDOW, "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .tooltip(&app.package_info().name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_WINDOW => show_main_window(app),
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let result = (|| {
        window.show()?;
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.set_focus()
    })();
    if let Err(error) = result {
        eprintln!("Failed to restore the main window: {error}");
    }
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let app = window.app_handle();
        close_main_window(
            app.tray_by_id(TRAY_ID).is_some(),
            || window.hide(),
            || app.exit(0),
        );
    }
}

fn close_main_window(
    tray_available: bool,
    hide: impl FnOnce() -> tauri::Result<()>,
    quit: impl FnOnce(),
) {
    if tray_available {
        match hide() {
            Ok(()) => return,
            Err(error) => eprintln!("Failed to hide the main window: {error}"),
        }
    }
    quit();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn closing_with_a_tray_hides_the_window_without_exiting() {
        let actions = RefCell::new(Vec::new());
        close_main_window(
            true,
            || {
                actions.borrow_mut().push("hide");
                Ok(())
            },
            || actions.borrow_mut().push("exit"),
        );
        assert_eq!(actions.into_inner(), ["hide"]);
    }

    #[test]
    fn closing_without_a_tray_requests_exit_without_hiding_the_window() {
        let exited = std::cell::Cell::new(false);
        close_main_window(
            false,
            || panic!("the window must stay visible until exit"),
            || exited.set(true),
        );
        assert!(exited.get());
    }
}
