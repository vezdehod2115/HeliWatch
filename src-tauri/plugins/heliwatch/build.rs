const COMMANDS: &[&str] = &[
    "site_init",
    "site_load",
    "site_nav",
    "site_cmd",
    "site_regions",
    "site_info",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
