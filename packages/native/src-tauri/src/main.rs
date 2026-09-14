// The desktop entry point, and nothing else lives here.
//
// Everything is in `lib.rs` because a mobile target does not use this file at
// all: `tauri ios`/`tauri android` build the library and call `run()` from a
// generated shim. Keeping the binary this thin is what makes "prepared for
// mobile" a property of the layout rather than a promise.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    reemoat_native_lib::run()
}
