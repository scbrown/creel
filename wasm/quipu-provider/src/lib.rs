//! creel's in-page quipu provider: quipu's MCP tool surface over wasm-bindgen.
//!
//! Runs inside a **dedicated Web Worker** (OPFS's `FileSystemSyncAccessHandle`
//! only exists there, and quipu's parking_lot locks must not block the main
//! thread). The JS glue (`app/quipu-worker.js`) relays the harness's MCP
//! `tools/list` / `tools/call` frames to `tool_definitions` / `call_tool`.
//!
//! The dispatch table below mirrors quipu's `src/server.rs` routing 1:1 —
//! same names, same `tool_*` fns — so the in-page surface is byte-identical
//! to what quipu-server (and bobbin) serve over the network. Tools whose
//! backing feature is off in this build (SHACL validation details, ONNX
//! embeddings, OWL) still dispatch; they answer with their built-in
//! degraded/error responses rather than vanishing from the schema list.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

thread_local! {
    static STORE: RefCell<Option<quipu::Store>> = const { RefCell::new(None) };
}

fn err_js(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Install the opfs-sahpool VFS as the process-wide default, so `open(path)`
/// persists across reloads. Call once per worker, before `open`. Optional:
/// without it, stores are memory-backed and die with the tab.
#[wasm_bindgen]
pub async fn install_opfs() -> Result<(), JsValue> {
    use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, install};
    install::<sqlite_wasm_rs::WasmOsCallback>(&OpfsSAHPoolCfg::default(), true)
        .await
        .map(|_| ())
        .map_err(err_js)
}

/// Open (or create) the store at `path` (OPFS if `install_opfs` ran).
#[wasm_bindgen]
pub fn open(path: &str) -> Result<(), JsValue> {
    let store = quipu::Store::open(path).map_err(err_js)?;
    STORE.with(|s| *s.borrow_mut() = Some(store));
    Ok(())
}

/// Open a fresh in-memory store.
#[wasm_bindgen]
pub fn open_memory() -> Result<(), JsValue> {
    let store = quipu::Store::open_in_memory().map_err(err_js)?;
    STORE.with(|s| *s.borrow_mut() = Some(store));
    Ok(())
}

/// Open a store from `.db` bytes (a knowledge pack or any quipu store file).
#[wasm_bindgen]
pub fn open_from_bytes(bytes: &[u8]) -> Result<(), JsValue> {
    let store = quipu::Store::open_from_bytes(bytes).map_err(err_js)?;
    STORE.with(|s| *s.borrow_mut() = Some(store));
    Ok(())
}

/// Serialize the current store to `.db` bytes (the interchange format —
/// downloadable, attachable to a native store, openable in the CLI).
#[wasm_bindgen]
pub fn export_db() -> Result<Vec<u8>, JsValue> {
    STORE.with(|s| {
        s.borrow()
            .as_ref()
            .ok_or_else(|| err_js("no store open"))?
            .serialize_db()
            .map_err(err_js)
    })
}

/// quipu's MCP tool schemas, verbatim — a JSON array string.
#[wasm_bindgen]
pub fn tool_definitions() -> String {
    serde_json::Value::Array(quipu::tool_definitions()).to_string()
}

/// Dispatch one MCP tool call. `args_json` is the tool's `arguments` object;
/// returns the tool's JSON result as a string, or the error message.
#[wasm_bindgen]
pub fn call_tool(name: &str, args_json: &str) -> Result<String, JsValue> {
    let input: serde_json::Value = serde_json::from_str(args_json).map_err(err_js)?;
    STORE.with(|s| {
        let mut guard = s.borrow_mut();
        let store = guard.as_mut().ok_or_else(|| err_js("no store open"))?;
        dispatch(store, name, &input)
            .map(|v| v.to_string())
            .map_err(err_js)
    })
}

/// The name → fn table, mirroring `src/server.rs` in quipu.
fn dispatch(
    store: &mut quipu::Store,
    name: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, quipu::Error> {
    use quipu as q;
    match name {
        "quipu_query" => q::tool_query(store, input),
        "quipu_export" => q::tool_export(store, input),
        "quipu_knot" => q::tool_knot(store, input),
        "quipu_cord" => q::tool_cord(store, input),
        "quipu_unravel" => q::tool_unravel(store, input),
        "quipu_validate" => q::tool_validate(input),
        "quipu_shapes" => q::tool_shapes(store, input),
        "quipu_queries" => q::tool_queries(store, input),
        "quipu_datasets" => q::tool_datasets(store, input),
        "quipu_retract" => q::tool_retract(store, input),
        "quipu_set" => q::tool_set(store, input),
        "quipu_retract_episode" => q::tool_retract_episode(store, input),
        "quipu_episode" => q::tool_episode(store, input),
        "quipu_search" => q::tool_search(store, input),
        "quipu_hybrid_search" => q::tool_hybrid_search(store, input),
        "quipu_search_nodes" => q::tool_search_nodes(store, input),
        "quipu_search_facts" => q::tool_search_facts(store, input),
        "quipu_episodes_complete" => q::tool_episodes_complete(store, input),
        "quipu_impact" => q::tool_impact(store, input),
        "quipu_unified_search" => q::tool_unified_search(store, input),
        "quipu_ask" => q::tool_ask(store, input),
        "quipu_propose_schema_change" => q::tool_propose_schema_change(store, input),
        "quipu_list_proposals" => q::tool_list_proposals(store, input),
        "quipu_accept_proposal" => q::tool_accept_proposal(store, input),
        "quipu_reject_proposal" => q::tool_reject_proposal(store, input),
        "quipu_resolve_entity" => q::tool_resolve_entity(store, input),
        "quipu_graph" => q::tool_graph_view(store, input),
        "quipu_project" => q::tool_project(store, input),
        "quipu_context" => q::tool_context(store, input),
        "quipu_report" => q::tool_report(store, input),
        "quipu_policy_check" => q::tool_policy_check(store, input),
        "quipu_verdict_verify" => q::tool_verdict_verify(store, input),
        "quipu_verifier_authorized" => q::tool_verifier_authorized(store, input),
        "quipu_cooccurrence" => q::tool_cooccurrence(store, input),
        "quipu_overlay_create" => q::tool_overlay_create(store, input),
        "quipu_overlay_write" => q::tool_overlay_write(store, input),
        "quipu_overlay_compose" => q::tool_overlay_compose(store, input),
        #[cfg(feature = "owl")]
        "quipu_load_ontology" => q::tool_load_ontology(store, input),
        other => Err(quipu::Error::InvalidValue(format!("unknown tool: {other}"))),
    }
}
