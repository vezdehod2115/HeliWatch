mod db;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::Wry;

/// Диагностический плагин: печатает в logcat, что Tauri дошёл до его setup.
/// Порядок регистрации показывает, на каком плагине падает запуск.
fn probe(name: &'static str) -> TauriPlugin<Wry> {
    PluginBuilder::<Wry>::new(name)
        .setup(move |_app, _api| {
            eprintln!("[heliwatch] plugin setup: {name}");
            log::info!("[heliwatch] plugin setup: {name}");
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        // На Android stderr попадает в logcat с тегом RustStdoutStderr.
        eprintln!("[heliwatch] PANIC: {info}");
    }));
    eprintln!("[heliwatch] Rust run() start");

    let result = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(probe("probe-before-sql"))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .plugin(probe("probe-after-sql"))
        .plugin(tauri_plugin_heliwatch::init())
        .setup(|_app| {
            // Сюда управление доходит только после setup всех плагинов.
            eprintln!("[heliwatch] app setup reached");
            log::info!("[heliwatch] app setup reached");
            Ok(())
        })
        .run(tauri::generate_context!());

    match result {
        Ok(()) => eprintln!("[heliwatch] Rust run() returned normally"),
        Err(error) => eprintln!("[heliwatch] RUN ERROR: {error}"),
    }
}
