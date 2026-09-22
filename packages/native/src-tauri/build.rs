fn main() {
    /*
     * ⚠ **`option_env!` is baked into a cached object file, and this is what makes
     * a changed value rebuild.** `config.rs` reads `REEMOAT_DEFAULT_SERVER` at
     * compile time — the only moment a fork can say which fleet its build joins,
     * a bundle having no environment to read when Finder or a desktop entry
     * launches it. Without this line cargo has no reason to recompile when the
     * variable moves, so a fork that corrects its address gets a binary that
     * silently keeps the previous one, with nothing anywhere saying why.
     */
    println!("cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER");
    tauri_build::build()
}
