//! creel's in-page yupana provider: structural code analysis over wasm-bindgen.
//!
//! Yupana's analysis core (tree-sitter extraction, six grammars) runs in the
//! page; this crate holds an **in-memory project** — the files a burst's
//! agents are reading and writing, fed in explicitly via `yupana_load_file` —
//! and serves structural facts about it through the same provider contract
//! quipu-backend.js documents: `tool_definitions()` + `call_tool()`.
//!
//! The browser has no filesystem to walk, so the load surface is in-page-only;
//! the query tools (`yupana_symbols`, `yupana_references`, `yupana_callers`,
//! `yupana_callees`, `yupana_analyze`) mirror yupana's native MCP tools of the
//! same names — same response fields, so an agent moving between a bobbin
//! session and a creel tab reads the same shapes. Every fact carries yupana's
//! FR-3 `tier` tag (`treesitter`, via `Tier::as_str`): the call graph here is
//! name-level tree-sitter approximation, and nothing may present it as more.
//!
//! References/callers/callees answer over ALL loaded files; a symbol absent
//! from the project answers `found: false` over a reported project size, so
//! "not loaded" and "does not exist" stay distinguishable (yupana #76's rule).

use std::cell::RefCell;
use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;
use yupana::extract::{self, FileStructure};
use yupana::types::Tier;

thread_local! {
    static PROJECT: RefCell<BTreeMap<String, FileStructure>> =
        RefCell::new(BTreeMap::new());
}

fn err_js(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn tier() -> &'static str {
    Tier::TreeSitter.as_str()
}

/// Infer the extraction language for `path` from its extension, honoring the
/// grammar set this build carries.
fn language_for_path(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?;
    extract::language_for_extension(ext)
}

/// The languages this build can extract.
#[wasm_bindgen]
pub fn languages() -> String {
    serde_json::json!(extract::languages()).to_string()
}

/// The provider's MCP tool schemas — a JSON array string (the shape
/// quipu-backend.js's provider contract expects from `listTools`).
#[wasm_bindgen]
pub fn tool_definitions() -> String {
    let schema = |props: serde_json::Value, required: &[&str]| {
        serde_json::json!({ "type": "object", "properties": props, "required": required })
    };
    let tools = serde_json::json!([
        {
            "name": "yupana_status",
            "description": "Yupana in-page engine status: loaded files, symbol count, grammar set, served tier.",
            "inputSchema": schema(serde_json::json!({}), &[]),
        },
        {
            "name": "yupana_load_file",
            "description": "Load (or reload) one source file into the in-page project and extract its structure. \
                            The browser engine has no filesystem: feed it every file you want queries to see.",
            "inputSchema": schema(serde_json::json!({
                "path": { "type": "string", "description": "Project-relative path, e.g. 'src/main.rs'. Its extension picks the grammar." },
                "source": { "type": "string", "description": "Full file contents." },
            }), &["path", "source"]),
        },
        {
            "name": "yupana_unload_file",
            "description": "Remove one file from the in-page project.",
            "inputSchema": schema(serde_json::json!({
                "path": { "type": "string", "description": "The path it was loaded under." },
            }), &["path"]),
        },
        {
            "name": "yupana_symbols",
            "description": "The symbol tree of one loaded file (name, kind, line span; tree-sitter tier).",
            "inputSchema": schema(serde_json::json!({
                "file": { "type": "string", "description": "A path previously passed to yupana_load_file." },
            }), &["file"]),
        },
        {
            "name": "yupana_references",
            "description": "Definition sites of a symbol by name, across every loaded file.",
            "inputSchema": schema(serde_json::json!({
                "symbol": { "type": "string", "description": "Symbol name to locate, e.g. 'authenticate'." },
            }), &["symbol"]),
        },
        {
            "name": "yupana_callers",
            "description": "Call sites that invoke the named function/method, across every loaded file \
                            (name-level, tree-sitter tier).",
            "inputSchema": schema(serde_json::json!({
                "symbol": { "type": "string", "description": "Callee name." },
            }), &["symbol"]),
        },
        {
            "name": "yupana_callees",
            "description": "Functions/methods the named function invokes, across every loaded file \
                            (name-level, tree-sitter tier).",
            "inputSchema": schema(serde_json::json!({
                "symbol": { "type": "string", "description": "Caller name." },
            }), &["symbol"]),
        },
        {
            "name": "yupana_analyze",
            "description": "Structural summary of the loaded project: files, symbols by kind, call sites, \
                            cross-file same-name collisions.",
            "inputSchema": schema(serde_json::json!({}), &[]),
        },
    ]);
    tools.to_string()
}

/// Dispatch one MCP tool call. `args_json` is the tool's `arguments` object;
/// returns the tool's JSON result as a string.
#[wasm_bindgen]
pub fn call_tool(name: &str, args_json: &str) -> Result<String, JsValue> {
    let args: serde_json::Value = serde_json::from_str(args_json).map_err(err_js)?;
    let str_arg = |key: &str| -> Result<String, JsValue> {
        args.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| err_js(format!("missing required argument: {key}")))
    };

    let result = match name {
        "yupana_status" => PROJECT.with(|p| {
            let p = p.borrow();
            let symbols: usize = p.values().map(|f| f.symbols.len()).sum();
            serde_json::json!({
                "engine": "yupana-wasm",
                "version": env!("CARGO_PKG_VERSION"),
                "loaded_files": p.len(),
                "symbols": symbols,
                "languages": extract::languages(),
                "tiers": [tier()],
            })
        }),

        "yupana_load_file" => {
            let path = str_arg("path")?;
            let source = str_arg("source")?;
            let language = language_for_path(&path).ok_or_else(|| {
                err_js(format!(
                    "no grammar for '{path}' (languages: {})",
                    extract::languages().join(", ")
                ))
            })?;
            let structure = extract::extract_structure(&source, language).map_err(err_js)?;
            let (symbols, calls) = (structure.symbols.len(), structure.calls.len());
            PROJECT.with(|p| p.borrow_mut().insert(path.clone(), structure));
            serde_json::json!({
                "file": path,
                "language": language,
                "symbols": symbols,
                "calls": calls,
                "tier": tier(),
            })
        }

        "yupana_unload_file" => {
            let path = str_arg("path")?;
            let removed = PROJECT.with(|p| p.borrow_mut().remove(&path).is_some());
            serde_json::json!({ "file": path, "removed": removed })
        }

        // Mirrors native SymbolsResponse: file / count / symbols[SymbolItem].
        "yupana_symbols" => {
            let file = str_arg("file")?;
            PROJECT.with(|p| {
                let p = p.borrow();
                let Some(structure) = p.get(&file) else {
                    return Err(err_js(format!("file not loaded: {file}")));
                };
                let symbols: Vec<_> = structure
                    .symbols
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "name": s.name,
                            "kind": s.kind.as_str(),
                            "start_line": s.start_line,
                            "end_line": s.end_line,
                            "tier": s.tier.as_str(),
                        })
                    })
                    .collect();
                Ok(serde_json::json!({
                    "file": file, "count": symbols.len(), "symbols": symbols,
                }))
            })?
        }

        // Mirrors native ReferencesResponse: symbol / count / definitions /
        // searched_symbols / tier.
        "yupana_references" => {
            let symbol = str_arg("symbol")?;
            PROJECT.with(|p| {
                let p = p.borrow();
                let searched: usize = p.values().map(|f| f.symbols.len()).sum();
                let definitions: Vec<_> = p
                    .iter()
                    .flat_map(|(file, f)| {
                        f.symbols.iter().filter(|s| s.name == symbol).map(move |s| {
                            serde_json::json!({
                                "file": file,
                                "name": s.name,
                                "kind": s.kind.as_str(),
                                "start_line": s.start_line,
                                "tier": s.tier.as_str(),
                            })
                        })
                    })
                    .collect();
                serde_json::json!({
                    "symbol": symbol,
                    "count": definitions.len(),
                    "definitions": definitions,
                    "searched_symbols": searched,
                    "tier": tier(),
                })
            })
        }

        // Mirror native NeighborsResponse: symbol / found / count / neighbors /
        // tier, with `via` = "called_by" | "calls" as on the native side.
        "yupana_callers" | "yupana_callees" => {
            let symbol = str_arg("symbol")?;
            let callers = name == "yupana_callers";
            PROJECT.with(|p| {
                let p = p.borrow();
                let found = p.values().any(|f| {
                    f.symbols.iter().any(|s| s.name == symbol)
                        || f.calls
                            .iter()
                            .any(|c| c.caller == symbol || c.callee == symbol)
                });
                let neighbors: Vec<_> = p
                    .iter()
                    .flat_map(|(file, f)| {
                        f.calls
                            .iter()
                            .filter(|c| {
                                if callers {
                                    c.callee == symbol
                                } else {
                                    c.caller == symbol
                                }
                            })
                            .map(move |c| {
                                serde_json::json!({
                                    "name": if callers { &c.caller } else { &c.callee },
                                    "file": file,
                                    "start_line": c.line,
                                    "distance": 1,
                                    "via": if callers { "called_by" } else { "calls" },
                                    "tier": tier(),
                                })
                            })
                    })
                    .collect();
                serde_json::json!({
                    "symbol": symbol,
                    "found": found,
                    "count": neighbors.len(),
                    "neighbors": neighbors,
                    "tier": tier(),
                })
            })
        }

        "yupana_analyze" => PROJECT.with(|p| {
            let p = p.borrow();
            let mut by_kind: BTreeMap<&'static str, usize> = BTreeMap::new();
            let mut calls = 0usize;
            for f in p.values() {
                calls += f.calls.len();
                for s in &f.symbols {
                    *by_kind.entry(s.kind.as_str()).or_default() += 1;
                }
            }
            // Cross-file same-name collisions: the census native
            // yupana_analyze surfaces per file, folded project-wide here.
            let mut sites: BTreeMap<&str, usize> = BTreeMap::new();
            for f in p.values() {
                for s in &f.symbols {
                    *sites.entry(s.name.as_str()).or_default() += 1;
                }
            }
            let collisions: Vec<_> = sites
                .iter()
                .filter(|(_, n)| **n > 1)
                .map(|(name, n)| serde_json::json!({ "name": name, "sites": n }))
                .collect();
            serde_json::json!({
                "files": p.len(),
                "symbols_by_kind": by_kind,
                "calls": calls,
                "collisions": collisions,
                "tier": tier(),
            })
        }),

        other => return Err(err_js(format!("unknown tool: {other}"))),
    };
    Ok(result.to_string())
}
