//! Browser authorization-code flow with PKCE (S256) for the IdP PROTOTYPE:
//!   GET  /authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256 -> HTML login form
//!   POST /authorize/login (application/x-www-form-urlencoded, credentials in the BODY only) -> 302 {redirect_uri}?code=..&state=..
//! Rules: client_id and redirect_uri must match the registration exactly BEFORE any form or redirect (invalid -> 400 page, never a redirect);
//! only S256; `state` is required and echoed; a wrong password re-renders the form (401) and never redirects; passwords never appear in URLs.
//! The code is single use and bound to the challenge, redirect_uri and client (see iam-idp). Not a standard OIDC implementation.
use crate::Core;
use axum::{Form, extract::{Query, State}, http::{HeaderMap, HeaderValue, StatusCode, header}, response::{IntoResponse, Response}};
use iam_idp::IdpError;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

fn esc(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;") }
fn pct(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }

/// Shared frame of every browser sign-in page: the random photo background, the lyam brand, the theme
/// selector and the footer are identical to the console's auth pages (apps/web login.css / styles.css).
/// A method (password, code, keypad, ...) only contributes the inner HTML of the central card.
/// No JavaScript by design (the CSP below forbids scripts): the theme selector is three plain links to
/// /authorize/theme, which remembers the choice in the `iam_theme` cookie shared with the console.
const CSS: &str = r#".brand-title .brand-baseline,.foot .brand-footer{font-size:0}.brand-baseline::after{content:var(--brand-baseline,"IAM next generation");font-size:.9rem}.brand-footer::after{content:var(--brand-footer,"Fictional demo data only. Do not enter real data.");font-size:.78rem}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--link)}
.auth-bg{position:fixed;inset:0;z-index:-2;background:radial-gradient(1200px 600px at 10% -10%,var(--accent) 0,transparent 60%),linear-gradient(160deg,var(--bg),var(--card))}
.auth-bg img{width:100%;height:100%;object-fit:cover;display:block}
.auth-veil{position:fixed;inset:0;z-index:-1;background:var(--veil)}
.seg{position:fixed;top:1rem;right:1rem;z-index:10;display:inline-flex;gap:.25rem;padding:.28rem;border-radius:999px;background:var(--card-auth);border:1px solid var(--line);box-shadow:0 1px 2px var(--shadow-color),0 4px 14px var(--shadow-color);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.seg a{display:inline-flex;align-items:center;gap:.35rem;padding:.32rem .7rem;border-radius:999px;color:var(--muted);font-size:.8rem;font-weight:600;text-decoration:none}
.seg a.on{background:var(--accent);color:var(--accent-ink)}
.seg a svg{width:.85rem;height:.85rem}
@media (max-width:480px){.seg a span{display:none}.seg a{padding:.32rem .55rem}}
.login{min-height:100vh;display:grid;place-items:center;padding:1.5rem}
.card{width:min(30rem,100%);background:var(--card-auth);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid var(--line);border-radius:.9rem;box-shadow:0 24px 60px var(--shadow-color);padding:2rem}
.brand{margin-bottom:1rem}
.brand-title{display:grid;gap:.2rem;justify-items:start}
.brandlogo{display:grid}
.brandlogo img{height:2.6rem;width:auto}
.brandlogo .for-dark{display:none}
:root[data-theme='dark'] .brandlogo .for-light{display:none}
:root[data-theme='dark'] .brandlogo .for-dark{display:block}
@media (prefers-color-scheme:dark){:root:not([data-theme='light']) .brandlogo .for-light{display:none}:root:not([data-theme='light']) .brandlogo .for-dark{display:block}}
.brand-title span{color:var(--brand-sub);font-size:.9rem}
.page-title{font-size:1.35rem;margin:0 0 .4rem;line-height:1.25}
p{margin:.4rem 0;color:var(--muted)}
.lead{color:var(--muted);line-height:1.5}
label{display:block;margin:.8rem 0 0;font-weight:600;color:var(--ink)}
input{display:block;width:100%;margin-top:.25rem;padding:.65rem .75rem;font:inherit;border:1px solid var(--line);border-radius:.55rem;background:var(--auth-field);color:var(--ink)}
input:focus{outline:2px solid var(--accent);border-color:var(--accent)}
button{margin-top:1.1rem;width:100%;padding:.7rem;font:inherit;font-weight:600;color:var(--accent-ink);background:var(--accent);border:0;border-radius:.55rem;cursor:pointer}
.err{color:var(--bad)}
.back{display:inline-block;margin-top:1rem}
.dots{display:flex;gap:.5rem;justify-content:center;margin:1rem 0}
.dots i{width:.85rem;height:.85rem;border-radius:50%;border:2px solid var(--accent)}
.dots i.on{background:var(--accent)}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem}
.pad .k{margin:0;padding:.7rem 0;background:var(--chip-bg);color:var(--chip-ink);display:flex;flex-direction:column;align-items:center;line-height:1.1;min-height:3.4rem}
.pad .k b{font-size:1.4rem}
.pad .k small{font-size:.65rem;letter-spacing:.18em;color:var(--muted);min-height:.8rem}
.pad .del{justify-content:center;font-size:1.3rem}
.pad .go{grid-column:1/-1;background:var(--accent);color:var(--accent-ink);min-height:0;padding:.75rem}
.pad .go:disabled{background:var(--line);color:var(--muted);cursor:default}
.demo{background:var(--warn-soft);border:1px solid var(--warn-line);border-radius:.55rem;padding:.5rem .7rem;color:var(--warn-ink)}
.foot{margin:1.2rem 0 0;font-size:.78rem;color:var(--muted)}
@media (max-width:480px){.login{padding:1rem}.card{padding:1.4rem}}"#;

const ICON_AUTO: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>"#;
const ICON_LIGHT: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>"#;
const ICON_DARK: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>"#;

/// The auto/light/dark selector: three links (no script). `back` is the page to return to.
fn theme_nav(theme: &str, back: &str) -> String {
    let b = pct(back);
    let link = |mode: &str, label: &str, icon: &str| format!("<a class=\"{}\" href=\"/authorize/theme?mode={mode}&amp;back={b}\"{}>{icon}<span>{label}</span></a>",
        if theme == mode { "on" } else { "" }, if theme == mode { " aria-current=\"true\"" } else { "" });
    format!("<nav class=\"seg\" aria-label=\"Color theme\">{}</nav>", [link("auto", "Auto", ICON_AUTO), link("light", "Light", ICON_LIGHT), link("dark", "Dark", ICON_DARK)].concat())
}

/// The GET-able authorize URL of a page, so the theme links can come back to it. On a step page the
/// running attempt is abandoned (like "Choose another sign-in method"): the chain restarts at step 1.
fn authorize_back(p: &HashMap<String, String>) -> String {
    let mut q: Vec<String> = if p.contains_key("response_type") { vec![] } else { vec!["response_type=code".to_string()] };
    for k in ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "chain", "branch", "ticket"] {
        if let Some(v) = p.get(k) { q.push(format!("{k}={}", pct(v))); }
    }
    format!("/authorize?{}", q.join("&"))
}

/// The remembered theme choice (`iam_theme` cookie, written here or mirrored by the console). Default: auto.
fn theme_of(h: &HeaderMap) -> String {
    h.get(header::COOKIE).and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').filter_map(|c| c.trim().split_once('=')).find(|(k, _)| k.trim() == "iam_theme").map(|(_, v)| v.trim().to_string()))
        .filter(|v| ["auto", "light", "dark"].contains(&v.as_str()))
        .unwrap_or_else(|| "auto".to_string())
}

/// Remembers the theme choice and returns to the page the user was on. `back` must stay a local
/// /authorize URL: anything else (external or protocol-relative) falls back to a bare /authorize.
pub async fn set_theme(Query(q): Query<HashMap<String, String>>) -> Response {
    let mode = q.get("mode").map(String::as_str).filter(|m| ["auto", "light", "dark"].contains(m)).unwrap_or("auto");
    let back = q.get("back").map(String::as_str).filter(|b| b.starts_with("/authorize") && !b.starts_with("//")).unwrap_or("/authorize");
    let mut r = (StatusCode::SEE_OTHER, [(header::LOCATION, back.to_string())]).into_response();
    if let Ok(v) = HeaderValue::from_str(&format!("iam_theme={mode}; Path=/; Max-Age=31536000; SameSite=Lax")) { r.headers_mut().insert(header::SET_COOKIE, v); }
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// The whole page: common frame + the card inner HTML supplied by the sign-in step being rendered.
fn frame(title: &str, card: &str, theme: &str, back: &str) -> String {
    let query = back.split_once('?').map(|(_,q)| q).unwrap_or("");
    let parts: Vec<&str> = query.split('&').filter(|p|p.starts_with("branch=")||p.starts_with("ticket=")).collect();
    let suffix = if parts.len()==2 { format!("?{}",parts.join("&amp;")) } else { String::new() };
    let attr = if theme == "light" || theme == "dark" { format!(" data-theme=\"{theme}\"") } else { String::new() };
    format!("<!doctype html><html lang=\"en\"{attr}><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{}</title><link rel=\"icon\" href=\"/api/tenants/acme-demo/branding/favicon.svg{suffix}\" type=\"image/svg+xml\"><link rel=\"icon\" href=\"/favicon-32.png\" sizes=\"32x32\" type=\"image/png\"><link rel=\"apple-touch-icon\" href=\"/favicon-180.png\"><style>{}{CSS}</style><link rel=\"stylesheet\" href=\"/api/tenants/acme-demo/branding/theme.css{suffix}\"></head>\
<body><div class=\"auth-bg\" aria-hidden=\"true\"><img src=\"https://picsum.photos/1920/1080\" alt=\"\"></div><div class=\"auth-veil\" aria-hidden=\"true\"></div>{}\
<main class=\"login\"><section class=\"card\"><div class=\"brand\"><div class=\"brand-title\"><picture class=\"brandlogo\">\
<img class=\"for-light\" src=\"/api/tenants/acme-demo/branding/logo-horizontal-light.svg{suffix}\" alt=\"lyam\"><img class=\"for-dark\" src=\"/api/tenants/acme-demo/branding/logo-horizontal-dark.svg{suffix}\" alt=\"\" aria-hidden=\"true\"></picture><span class=\"brand-baseline\">IAM next generation</span></div></div>\
{}<p class=\"foot\"><span class=\"brand-footer\">Fictional demo data only. Do not enter real data.</span> <a href=\"/privacy\">Politique de confidentialité / Privacy</a> &middot; <a href=\"/about\">About this demo</a></p></section></main></body></html>",
        esc(title), include_str!("branding-default.css"), theme_nav(theme, back), card)
}

fn page(status: StatusCode, body: String, form_target: Option<&str>) -> Response {
    let mut r = (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response();
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    // No scripts (keypad flows stay scriptless on purpose). Images: the same-origin brand assets and the
    // picsum background (it redirects to fastly.picsum.photos, so both hosts are allowed).
    // Browsers also apply form-action to the redirect that follows the POST: the (already validated, registered) redirect origin must be allowed.
    let csp = format!("default-src 'none'; img-src 'self' https://picsum.photos https://fastly.picsum.photos; style-src 'self' 'unsafe-inline'; form-action 'self'{}", form_target.map(|o| format!(" {o}")).unwrap_or_default());
    if let Ok(v) = HeaderValue::from_str(&csp) { h.insert(header::CONTENT_SECURITY_POLICY, v); }
    r
}
fn error_page(status: StatusCode, msg: &str, theme: &str) -> Response { page(status, frame("Sign-in error", &format!("<h1 class=\"page-title\">Sign-in error</h1><p class=\"err\">{}</p>", esc(msg)), theme, "/authorize"), None) }


fn hidden(p: &HashMap<String, String>) -> String {
    ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "chain", "branch", "ticket"].iter()
        .map(|k| format!("<input type=\"hidden\" name=\"{k}\" value=\"{}\">", esc(p.get(*k).map(String::as_str).unwrap_or("")))).collect::<String>()
}
/// Back to the list of methods: only on pages of a chosen chain. It abandons the running attempt (its session id is not carried) and the sign-in page starts a new one with a fresh state and PKCE verifier.
fn back_link(p: &HashMap<String, String>) -> String {
    let o = origin_of(p);
    if p.get("chain").map(|c| c.is_empty()).unwrap_or(true) || o.is_empty() { return String::new(); }
    let test = match (p.get("branch"), p.get("ticket")) {
        (Some(b), Some(t)) if !b.is_empty() && !t.is_empty() => format!("?branch={}&ticket={}", pct(b), pct(t)),
        _ => String::new(),
    };
    format!("<p class=\"back\"><a id=\"back-to-methods\" href=\"{}/login{}\">&larr; Choose another sign-in method</a></p>", esc(&o), test)
}
fn origin_of(p: &HashMap<String, String>) -> String {
    let ru = p.get("redirect_uri").map(String::as_str).unwrap_or("");
    ru.splitn(4, '/').take(3).collect::<Vec<_>>().join("/") // scheme://host[:port] of a registered redirect_uri
}
/// One input of a step, from the control plane's description. Names are restricted to [a-z0-9]{1,12} and types to a fixed list: the description is not trusted as markup.
fn input_html(f: &Value) -> Option<String> {
    let name = f["name"].as_str().filter(|n| !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))?;
    let label = f["label"].as_str().unwrap_or(name);
    if f["type"].as_str() == Some("keypad") { return keypad_html(f, label); }
    let max = f["maxLength"].as_u64().filter(|m| (1..=64).contains(m)).map(|m| format!(" maxlength=\"{m}\"")).unwrap_or_default();
    let hint = f["hint"].as_str().map(|h| format!(" placeholder=\"{}\"", esc(h))).unwrap_or_default();
    // A step named "password" keeps the classic field name so the classic form and scripts keep working; every other input is a_<name>.
    let attr = if name == "password" { "password".to_string() } else { format!("a_{name}") };
    let kind = match f["type"].as_str() { Some("password") => "type=\"password\" autocomplete=\"off\"", Some("digits") => "type=\"text\" inputmode=\"numeric\" autocomplete=\"one-time-code\"", _ => "type=\"text\" autocomplete=\"off\"" };
    let kind = if name == "password" { "type=\"password\" autocomplete=\"current-password\"" } else { kind };
    Some(format!("<label>{} <input name=\"{attr}\" {kind}{max}{hint}></label> ", esc(label)))
}

/// Shuffled keypad: every button is a submit carrying only an opaque id valid for this page (the digit is never a form value).
/// Works without JavaScript (the page CSP forbids scripts): one POST per press, the server keeps the digits entered so far.
fn keypad_html(f: &Value, label: &str) -> Option<String> {
    let ok_id = |s: &str| !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let keys: Vec<(String, String, String)> = f["keys"].as_array()?.iter().filter_map(|k| {
        let (id, d, l) = (k["id"].as_str()?, k["digit"].as_str()?, k["letters"].as_str().unwrap_or(""));
        (ok_id(id) && d.len() == 1 && d.as_bytes()[0].is_ascii_digit() && l.len() <= 4 && l.bytes().all(|b| b.is_ascii_uppercase())).then(|| (id.to_string(), d.to_string(), l.to_string()))
    }).collect();
    if keys.len() != 10 { return None; }
    let len = f["length"].as_u64().filter(|n| (1..=12).contains(n)).unwrap_or(6) as usize;
    let got = (f["entered"].as_u64().unwrap_or(0) as usize).min(len);
    let dots: String = (0..len).map(|i| if i < got { "<i class=\"on\"></i>" } else { "<i></i>" }).collect();
    let btn = |k: &(String, String, String)| format!("<button type=\"submit\" class=\"k\" name=\"a_key\" value=\"{}\"><b>{}</b><small>{}</small></button>", esc(&k.0), esc(&k.1), esc(&k.2));
    let mut cells: String = keys[..9].iter().map(btn).collect();
    cells.push_str("<button type=\"submit\" class=\"k del\" name=\"a_action\" value=\"delete\" aria-label=\"Delete last digit\">&#9003;</button>");
    cells.push_str(&btn(&keys[9]));
    cells.push_str(&format!("<button type=\"submit\" class=\"k go\" name=\"a_action\" value=\"submit\"{}>Sign in</button>", if got == len { "" } else { " disabled" }));
    Some(format!("<div class=\"dots\" role=\"img\" aria-label=\"{got} of {len} digits entered\">{dots}</div><div class=\"pad\" aria-label=\"{}\">{cells}</div>", esc(label)))
}

/// First page. `fields` None = the classic user + password form (no chain is live). Some(fields) = user name plus the first step's inputs (possibly none).
fn form(p: &HashMap<String, String>, error: Option<&str>, fields: Option<&[Value]>, theme: &str) -> Response {
    let hid = hidden(p);
    let err = error.map(|e| format!("<p class=\"err\" role=\"alert\">{}</p>", esc(e))).unwrap_or_default();
    let inputs = match fields {
        None => "<label>Password <input name=\"password\" type=\"password\" autocomplete=\"current-password\"></label> ".to_string(),
        Some(f) => f.iter().filter_map(input_html).collect::<String>(),
    };
    let button = if fields.is_some_and(|f| f.is_empty()) { "Continue" } else { "Sign in" };
    let card = format!("<h1 class=\"page-title\">Sign in</h1><p class=\"lead\">OAuth/OIDC-inspired authentication prototype, local demo accounts only.</p>{err}\
         <form method=\"post\" action=\"/authorize/login\">{hid}<label>User <input name=\"username\" autocomplete=\"username\"></label> {inputs}<button type=\"submit\">{button}</button></form>{}", back_link(p));
    page(if error.is_some() { StatusCode::UNAUTHORIZED } else { StatusCode::OK }, frame("Sign in (local prototype)", &card, theme, &authorize_back(p)), Some(&origin_of(p)))
}

/// The chains the live configuration offers: one link each (plain HTML, no script). The link only adds `chain=<id>`; the control plane re-checks the id at every step.
fn choice_page(p: &HashMap<String, String>, chains: &[Value], theme: &str) -> Response {
    let base = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "branch", "ticket"].iter()
        .filter_map(|k| p.get(*k).map(|v| format!("{k}={}", pct(v)))).collect::<Vec<_>>().join("&");
    let items = chains.iter().filter_map(|c| {
        let id = c["id"].as_str().filter(|i| !i.is_empty() && i.len() <= 40 && i.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))?;
        let steps = c["steps"].as_array().map(|a| a.iter().filter_map(|s| s["name"].as_str().map(esc)).collect::<Vec<_>>().join(" &rarr; ")).unwrap_or_default();
        let lvl = c["effectiveLevel"].as_u64().unwrap_or(0);
        let sim = if c["simulated"].as_bool().unwrap_or(false) { " <span class=\"demo\">includes a simulated step (no real e-mail)</span>" } else { "" };
        let rec = if c["recommended"].as_bool().unwrap_or(false) { " <b>(recommended)</b>" } else { "" };
        Some(format!("<li><a class=\"chain\" href=\"/authorize?{base}&amp;chain={}\"><b>{}</b>{rec}</a><br><small>{steps} &middot; declared level {lvl} of 10{sim}</small></li>", pct(id), esc(c["name"].as_str().unwrap_or(id))))
    }).collect::<String>();
    let card = format!("<h1 class=\"page-title\">Choose how to sign in</h1><p class=\"lead\">Pick one of the methods configured and enabled for this demo. Levels are declared by an administrator (10 = strongest), not measured. Fictional accounts only.</p><ul style=\"padding-left:1.1rem;line-height:1.7\">{items}</ul>");
    page(StatusCode::OK, frame("Choose how to sign in", &card, theme, &authorize_back(p)), Some(&origin_of(p)))
}

/// A later step of a chain: the opaque session id is the only link to the first page (the user name is not sent again).
fn step_page(p: &HashMap<String, String>, v: &Value, error: Option<&str>, theme: &str) -> Response {
    let st = &v["step"];
    let title = st["title"].as_str().unwrap_or("Verification");
    let (i, n) = (st["index"].as_u64().unwrap_or(0) + 1, st["total"].as_u64().unwrap_or(1));
    let msg = st["message"].as_str().map(|m| format!("<p{}>{}</p>", if m.starts_with("DEMO") { " class=\"demo\"" } else { "" }, esc(m))).unwrap_or_default();
    let err = error.or(v["error"].as_str()).map(|e| format!("<p class=\"err\" role=\"alert\">{}</p>", esc(e))).unwrap_or_default();
    let inputs = st["fields"].as_array().map(|f| f.iter().filter_map(input_html).collect::<String>()).unwrap_or_default();
    let cont = if inputs.contains("class=\"pad\"") { "" } else { "<button type=\"submit\">Continue</button>" };
    let card = format!("<h1 class=\"page-title\">{}</h1><p class=\"lead\">Step {i} of {n}.</p>{msg}{err}\
         <form method=\"post\" action=\"/authorize/login\">{}<input type=\"hidden\" name=\"session\" value=\"{}\">{inputs}{cont}</form>{}",
        esc(title), hidden(p), esc(v["session"].as_str().unwrap_or("")), back_link(p));
    page(if error.is_some() || v["error"].is_string() { StatusCode::UNAUTHORIZED } else { StatusCode::OK }, frame(&format!("Sign in, step {i} of {n}"), &card, theme, &authorize_back(p)), Some(&origin_of(p)))
}

/// Validates the authorization request parameters. Err = (status, message), never a redirect.
fn validate(c: &Core, p: &HashMap<String, String>, theme: &str) -> Result<(), Response> {
    let g = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
    if !c.idp.check_client(g("client_id"), g("redirect_uri")) { return Err(error_page(StatusCode::BAD_REQUEST, "unknown client or redirect_uri", &theme)); }
    if p.get("response_type").map(String::as_str).unwrap_or("code") != "code" { return Err(error_page(StatusCode::BAD_REQUEST, "only response_type=code", &theme)); }
    if g("code_challenge_method") != "S256" { return Err(error_page(StatusCode::BAD_REQUEST, "code_challenge_method must be S256", &theme)); }
    if g("code_challenge").len() < 43 || g("code_challenge").len() > 128 { return Err(error_page(StatusCode::BAD_REQUEST, "invalid code_challenge", &theme)); }
    if g("state").is_empty() || g("state").len() > 256 { return Err(error_page(StatusCode::BAD_REQUEST, "state is required (max 256 chars)", &theme)); }
    // Branch test (docs/branch-test.md): a non-main Dolt data branch plus the short-lived ticket the console issued to an administrator.
    let (b, t) = (g("branch"), g("ticket"));
    if !b.is_empty() {
        let ok = b.len() <= 32 && b.bytes().all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || x == b'-');
        if !ok || b == "main" { return Err(error_page(StatusCode::BAD_REQUEST, "invalid data branch", &theme)); }
        if t.len() < 10 || t.len() > 64 || !t.bytes().all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_') { return Err(error_page(StatusCode::BAD_REQUEST, "a branch test needs the ticket of the test link", &theme)); }
    } else if !t.is_empty() {
        return Err(error_page(StatusCode::BAD_REQUEST, "a branch-test ticket without a branch", &theme));
    }
    Ok(())
}

pub async fn authorize_form(State(c): State<Arc<Core>>, headers: HeaderMap, Query(p): Query<HashMap<String, String>>) -> Response {
    let theme = theme_of(&headers);
    if let Err(r) = validate(&c, &p, &theme) { return r; }
    let Some((addr, tok)) = &c.gate else { return form(&p, None, None, &theme) };
    let (b, t) = (p.get("branch").map(String::as_str), p.get("ticket").map(String::as_str));
    match crate::gate::entry(addr, tok, "acme-demo", p.get("chain").map(String::as_str), b, t).await {
        None => error_page(StatusCode::SERVICE_UNAVAILABLE, "sign-in is temporarily unavailable", &theme),
        Some(v) if v["mode"] == "error" => error_page(StatusCode::BAD_REQUEST, v["message"].as_str().unwrap_or("this sign-in link is not valid"), &theme),
        Some(v) if v["mode"] == "choice" => choice_page(&p, v["chains"].as_array().map(Vec::as_slice).unwrap_or(&[]), &theme),
        Some(v) if v["mode"] == "chain" => form(&p, None, Some(v["fields"].as_array().map(Vec::as_slice).unwrap_or(&[])), &theme),
        Some(_) => form(&p, None, None, &theme),
    }
}

pub async fn login(State(c): State<Arc<Core>>, headers: HeaderMap, Form(p): Form<HashMap<String, String>>) -> Response {
    let theme = theme_of(&headers);
    if let Err(r) = validate(&c, &p, &theme) { return r; } // hidden fields are not trusted: validated again
    let g = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
    let mut extra = Value::Null;
    let mut who = g("username").to_string();
    if let Some((addr, tok)) = &c.gate {
        // Everything the user typed for the step travels as `answers`; the control plane decides what it means. A bare `password` is the classic form.
        let mut answers = serde_json::Map::new();
        for (k, v) in &p { if let Some(n) = k.strip_prefix("a_").filter(|n| !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())) { answers.insert(n.to_string(), json!(v)); } }
        let session = g("session");
        let mut body = json!({"tenant": "acme-demo"});
        if !session.is_empty() { body["session"] = json!(session); } else { body["subject"] = json!(g("username")); if !g("password").is_empty() { body["password"] = json!(g("password")); } if !g("chain").is_empty() { body["chain"] = json!(g("chain")); } if !g("branch").is_empty() { body["branch"] = json!(g("branch")); body["ticket"] = json!(g("ticket")); } }
        if !answers.is_empty() { body["answers"] = Value::Object(answers); }
        // A step page has no first-page inputs: after a failed first page, show the first page again.
        let first_page = || async { match crate::gate::entry(addr, tok, "acme-demo", p.get("chain").map(String::as_str), p.get("branch").map(String::as_str), p.get("ticket").map(String::as_str)).await { Some(v) if v["mode"] == "chain" => Some(v["fields"].as_array().cloned().unwrap_or_default()), _ => None } };
        match crate::gate::step(addr, tok, body).await {
            crate::gate::Step::Allow { subject, claims } => {
                if !session.is_empty() { match subject { Some(s) => who = s, None => return form(&p, Some("Sign-in failed. Check your details and try again."), None, &theme) } } else if let Some(s) = subject { who = s; }
                extra = claims;
            }
            crate::gate::Step::Deny(m) => {
                c.bus_emit("signin.refused", serde_json::json!({"subject": g("username"), "client_id": g("client_id")}), None);
                let msg = m.unwrap_or_else(|| "Wrong user or password.".into());
                return match first_page().await { Some(f) => form(&p, Some(&msg), Some(&f), &theme), None => form(&p, Some(&msg), None, &theme) };
            }
            crate::gate::Step::Challenge(v) => return step_page(&p, &v, None, &theme),
            crate::gate::Step::Unavailable => return error_page(StatusCode::SERVICE_UNAVAILABLE, "sign-in is temporarily unavailable", &theme),
        }
    }
    let test_branch = if g("branch").is_empty() { None } else { Some(g("branch")) };
    match if c.gate.is_some() { c.idp.authorize_verified_on(g("client_id"), g("redirect_uri"), g("code_challenge"), &who, &extra, test_branch) } else { c.idp.authorize(g("client_id"), g("redirect_uri"), g("code_challenge"), g("username"), g("password")) } {
        Ok(code) => {
            c.bus_emit("signin.succeeded", serde_json::json!({"subject": if c.gate.is_some() { who.clone() } else { g("username").to_string() }, "client_id": g("client_id")}), None);
            let sep = if g("redirect_uri").contains('?') { '&' } else { '?' };
            let loc = format!("{}{sep}code={}&state={}", g("redirect_uri"), pct(&code), pct(g("state")));
            let mut r = (StatusCode::FOUND, [(header::LOCATION, loc)]).into_response();
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r
        }
        Err(IdpError::InvalidCredentials) => {
            c.bus_emit("signin.refused", serde_json::json!({"subject": g("username"), "client_id": g("client_id")}), None);
            form(&p, Some("Wrong user or password."), None, &theme)
        }
        Err(_) => error_page(StatusCode::BAD_REQUEST, "invalid request", &theme),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use iam_decision::Engine;
    use iam_idp::Idp;
    use tower::ServiceExt;

    const CH: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // S256 of the RFC 7636 example verifier
    const VER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CB: &str = "http://localhost:4200/callback";

    fn core() -> Arc<Core> { Arc::new(Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test"))) }
    async fn send(c: &Arc<Core>, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
        let r = app(c.clone()).oneshot(req).await.unwrap();
        let (st, h) = (r.status(), r.headers().clone());
        (st, h, String::from_utf8_lossy(&r.into_body().collect().await.unwrap().to_bytes()).into_owned())
    }
    fn get(q: &str) -> Request<Body> { Request::builder().uri(format!("/authorize?{q}")).body(Body::empty()).unwrap() }
    fn post_login(body: &str) -> Request<Body> {
        Request::builder().method("POST").uri("/authorize/login").header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
    }
    fn q(extra: &str) -> String { format!("response_type=code&client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=st%20ate&code_challenge={CH}&code_challenge_method=S256{extra}") }
    fn login_body(user: &str, pw: &str) -> String { format!("client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=st%20ate&code_challenge={CH}&code_challenge_method=S256&username={user}&password={pw}") }

    #[test]
    fn back_link_only_for_a_chosen_chain_and_never_carries_the_session() {
        let mut p: HashMap<String, String> = HashMap::new();
        p.insert("redirect_uri".into(), "https://app.example/callback".into());
        assert_eq!(super::back_link(&p), "");
        p.insert("chain".into(), "password-only".into());
        let l = super::back_link(&p);
        assert!(l.contains("href=\"https://app.example/login\"") && l.contains("Choose another sign-in method") && !l.contains("session") && !l.contains("state"));
    }
    #[tokio::test]
    async fn full_browser_flow_form_login_redirect_token() {
        let c = core();
        let (st, h, body) = send(&c, get(&q(""))).await;
        assert_eq!(st, StatusCode::OK);
        assert!(body.contains("type=\"password\"") && body.contains("action=\"/authorize/login\"") && body.contains("name=\"state\" value=\"st ate\""));
        assert_eq!(h["x-frame-options"], "DENY"); assert!(h[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("form-action 'self' http://localhost:4200"));
        let (st, h, _) = send(&c, post_login(&login_body("demo-alice", "demo-only-not-a-secret"))).await;
        assert_eq!(st, StatusCode::FOUND);
        let loc = h[header::LOCATION].to_str().unwrap().to_string();
        assert!(loc.starts_with(&format!("{CB}?code=")) && loc.ends_with("&state=st%20ate"), "{loc}");
        assert!(!loc.contains("demo-only-not-a-secret") && !loc.contains("password"));
        let code = loc.split("code=").nth(1).unwrap().split('&').next().unwrap();
        let tok = |code: &str, v: &str| Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{v}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        let (st, _, body) = send(&c, tok(code, VER)).await;
        assert_eq!(st, StatusCode::OK); assert!(body.contains("id_token"));
        assert_eq!(send(&c, tok(code, VER)).await.0, StatusCode::BAD_REQUEST); // single use
    }

    #[tokio::test]
    async fn negatives_never_redirect_and_never_leak() {
        let c = core();
        // unregistered redirect_uri / client: 400 page, no Location
        let (st, h, _) = send(&c, get(&q("").replace("localhost%3A4200", "evil.example"))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST); assert!(h.get(header::LOCATION).is_none());
        let (st, h, _) = send(&c, post_login(&login_body("demo-alice", "demo-only-not-a-secret").replace("localhost%3A4200", "evil.example"))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST); assert!(h.get(header::LOCATION).is_none());
        // prefix / suffix tricks are not exact matches
        for ru in ["http%3A%2F%2Flocalhost%3A4200%2Fcallback%2Fx", "http%3A%2F%2Flocalhost%3A4200%2Fcallback%3Fa%3D1", "http%3A%2F%2Flocalhost%3A4200"] {
            let b = login_body("demo-alice", "demo-only-not-a-secret").replace("http%3A%2F%2Flocalhost%3A4200%2Fcallback", ru);
            assert_eq!(send(&c, post_login(&b)).await.0, StatusCode::BAD_REQUEST, "{ru}");
        }
        // plain PKCE, missing method, missing state, short challenge, wrong response_type
        assert_eq!(send(&c, get(&q("").replace("S256", "plain"))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace("&code_challenge_method=S256", ""))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace("&state=st%20ate", ""))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace(CH, "short"))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace("response_type=code", "response_type=token"))).await.0, StatusCode::BAD_REQUEST);
        // wrong password / unknown user: 401 form again, no redirect, password not echoed
        let (st, h, body) = send(&c, post_login(&login_body("demo-alice", "wrong-pass-123"))).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none());
        assert!(body.contains("Wrong user or password") && !body.contains("wrong-pass-123"));
        assert_eq!(send(&c, post_login(&login_body("nobody", "x"))).await.0, StatusCode::UNAUTHORIZED);
        // HTML injection through parameters is escaped in the form
        let (_, _, body) = send(&c, get(&q("").replace("st%20ate", "%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E"))).await;
        assert!(!body.contains("<script>") && body.contains("&lt;script&gt;"));
        // wrong verifier burns the code
        let (_, h, _) = send(&c, post_login(&login_body("demo-bob", "demo-only-not-a-secret"))).await;
        let code = h[header::LOCATION].to_str().unwrap().split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
        let bad = Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}", "x".repeat(50)))).unwrap();
        assert_eq!(send(&c, bad).await.0, StatusCode::BAD_REQUEST);
        let good = Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{VER}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        assert_eq!(send(&c, good).await.0, StatusCode::BAD_REQUEST);
    }

    // ---- multi-step sign-in through a fake control-plane gate ----
    async fn fake_gate() -> String { fake_gate_with(false).await }
    /// `choice`: the control plane offers two chains and only accepts the one the form forwarded.
    async fn fake_gate_with(choice: bool) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move { loop {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = Vec::new(); let mut tmp = [0u8; 4096];
            loop { let n = s.read(&mut tmp).await.unwrap(); buf.extend_from_slice(&tmp[..n]); let t = String::from_utf8_lossy(&buf).to_string();
                if let Some(h) = t.find("\r\n\r\n") { let cl = t[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0); if buf.len() >= h + 4 + cl { break; } } if n == 0 { break; } }
            let t = String::from_utf8_lossy(&buf).to_string(); let path = t.split_whitespace().nth(1).unwrap().to_string();
            let body: Value = serde_json::from_str(t.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            let out = if choice && path.ends_with("/entry") { if body["chain"] == "pw-only" { json!({"mode":"chain","chain":{"id":"pw-only","name":"Password only"},"fields":[{"name":"password","label":"Password","type":"password"}]}) } else { json!({"mode":"choice","chains":[{"id":"pw-only","name":"Password <only>","effectiveLevel":3,"simulated":false,"recommended":true,"steps":[{"name":"Password"}]},{"id":"bad id","name":"Evil","steps":[]},{"id":"mail","name":"E-mail code","effectiveLevel":4,"simulated":true,"steps":[{"name":"E-mail"}]}]}) } }
            else if choice && body["session"].is_null() { if body["chain"] == "pw-only" && body["password"] == "pw" && body["subject"] == "demo-alice" { json!({"outcome":"allow","subject":"demo-alice","chain":"pw-only","claims":{"auth_chain":"pw-only"}}) } else { json!({"outcome":"deny","reason":"bad-credentials","message":"Sign-in failed. Check your details and try again."}) } }
            else if path.ends_with("/entry") { json!({"mode":"chain","fields":[{"name":"password","label":"Password","type":"password"}]}) }
            else if body["session"] == "sess1" {
                if body["answers"]["code"] == "123456" { json!({"outcome":"allow","subject":"demo-alice","chain":"mfa","claims":{"amr":["pwd","otp"],"auth_level":8,"auth_level_declared":9,"auth_mfa":true,"auth_level_basis":"configured","iss":"evil","sub":"evil","exp":1,"role":"admin"}}) }
                else { json!({"outcome":"challenge","session":"sess1","error":"Incorrect answer. 2 attempt(s) left.","step":{"index":1,"total":2,"title":"Authenticator code","fields":[{"name":"code","label":"Code","type":"digits","maxLength":6}]}}) }
            } else if body["password"] == "pw" && body["subject"] == "demo-alice" { json!({"outcome":"challenge","session":"sess1","step":{"index":1,"total":2,"title":"Authenticator <code>","message":"Open your app","fields":[{"name":"code","label":"Code","type":"digits","maxLength":6},{"name":"bad name","label":"x","type":"text"}]}}) }
            else { json!({"outcome":"deny","reason":"bad-credentials","message":"Sign-in failed. Check your details and try again."}) };
            let o = out.to_string(); s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{o}", o.len()).as_bytes()).await.unwrap();
        } });
        addr
    }
    #[tokio::test]
    async fn two_step_sign_in_filters_claims_and_never_trusts_the_form_user_after_the_first_step() {
        let addr = fake_gate().await;
        let mut core = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")); core.gate = Some((addr, "tok-12345678".into()));
        let c = Arc::new(core);
        let (st, _, body) = send(&c, get(&q(""))).await; assert_eq!(st, StatusCode::OK); assert!(body.contains("name=\"password\"") && body.contains("name=\"username\""));
        // first step wrong: back to the first page with the generic message, 401, no redirect
        let (st, h, body) = send(&c, post_login(&login_body("demo-alice", "bad"))).await; assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none() && body.contains("Sign-in failed") && body.contains("name=\"password\""));
        // first step right: a second page, escaped, only valid inputs, the session is the only link
        let (st, h, body) = send(&c, post_login(&login_body("demo-alice", "pw"))).await; assert_eq!(st, StatusCode::OK); assert!(h.get(header::LOCATION).is_none());
        assert!(body.contains("Step 2 of 2") && body.contains("Authenticator &lt;code&gt;") && body.contains("name=\"a_code\"") && body.contains("name=\"session\" value=\"sess1\""));
        assert!(!body.contains("bad name") && !body.contains("name=\"username\"") && !body.contains("<code>"));
        let step = |code: &str, who: &str| post_login(&format!("client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=st%20ate&code_challenge={CH}&code_challenge_method=S256&session=sess1&username={who}&a_code={code}"));
        let (st, h, body) = send(&c, step("000000", "demo-alice")).await; assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none() && body.contains("2 attempt(s) left") && body.contains("Step 2 of 2"));
        // right code, but the form claims another user: the identity is the one the control plane verified
        let (st, h, _) = send(&c, step("123456", "demo-bob")).await; assert_eq!(st, StatusCode::FOUND);
        let loc = h[header::LOCATION].to_str().unwrap().to_string(); let code = loc.split("code=").nth(1).unwrap().split('&').next().unwrap();
        let tok = Request::builder().method("POST").uri("/token").header("content-type", "application/json").body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{VER}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        let (st, _, body) = send(&c, tok).await; assert_eq!(st, StatusCode::OK);
        let idt = serde_json::from_str::<Value>(&body).unwrap()["id_token"].as_str().unwrap().to_string();
        let claims = iam_idp::verify(&idt, &c.idp.jwks(), "http://idp.test").unwrap();
        assert_eq!(claims["sub"], "demo-alice"); assert_eq!(claims["auth_level"], 8); assert_eq!(claims["auth_level_declared"], 9); assert_eq!(claims["auth_mfa"], true); assert_eq!(claims["amr"], json!(["pwd", "otp"]));
        assert_eq!(claims["auth_level_basis"], "configured"); assert_eq!(claims["iss"], "http://idp.test"); assert!(claims.get("role").is_none());
    }
    #[tokio::test]
    async fn an_unreachable_gate_refuses_the_form_and_the_login() {
        let mut core = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")); core.gate = Some(("127.0.0.1:1".into(), "tok-12345678".into()));
        let c = Arc::new(core);
        assert_eq!(send(&c, get(&q(""))).await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(send(&c, post_login(&login_body("demo-alice", "demo-only-not-a-secret"))).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn the_form_lists_the_offered_chains_and_forwards_the_picked_one() {
        let addr = fake_gate_with(true).await;
        let mut core = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")); core.gate = Some((addr, "tok-12345678".into()));
        let c = Arc::new(core);
        let (st, _, body) = send(&c, get(&q(""))).await; assert_eq!(st, StatusCode::OK);
        assert!(body.contains("Choose how to sign in") && body.contains("chain=pw-only") && body.contains("chain=mail"), "{body}");
        assert!(body.contains("Password &lt;only&gt;") && !body.contains("<only>"), "names are escaped");
        assert!(!body.contains("bad%20id") && !body.contains("Evil"), "an id outside [a-z0-9-] is never turned into a link");
        assert!(body.contains("simulated step") && body.contains("(recommended)"));
        assert!(!body.contains("name=\"password\""), "no password box before a method is picked");
        let (st, _, body) = send(&c, get(&q("&chain=pw-only"))).await; assert_eq!(st, StatusCode::OK);
        assert!(body.contains("name=\"chain\" value=\"pw-only\"") && body.contains("name=\"password\""), "{body}");
        let with = |chain: &str, pw: &str| post_login(&format!("{}&chain={chain}", login_body("demo-alice", pw)));
        let (st, h, _) = send(&c, with("pw-only", "pw")).await; assert_eq!(st, StatusCode::FOUND, "picked chain signs in"); assert!(h.get(header::LOCATION).is_some());
        let (st, h, _) = send(&c, with("mail", "pw")).await; assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none(), "another chain id is refused by the control plane");
        let (st, h, _) = send(&c, post_login(&login_body("demo-alice", "pw"))).await; assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none(), "no chain picked: no sign-in");
    }

    #[tokio::test]
    async fn branch_test_params_are_validated_carried_and_bound_into_the_token() {
        let c = core();
        // main and malformed branches never reach a form; a ticket without a branch is refused
        for extra in ["&branch=main", "&branch=Bad_Branch", "&branch=a..b", "&ticket=someticket123"] {
            let (st, h, _) = send(&c, get(&q(extra))).await;
            assert_eq!(st, StatusCode::BAD_REQUEST, "{extra}"); assert!(h.get(header::LOCATION).is_none());
        }
        // a well-formed pair renders the classic form (no gate configured here) and keeps both in the hidden fields
        let (st, _, body) = send(&c, get(&q("&branch=feature-x&ticket=ticket-1234567890"))).await;
        assert_eq!(st, StatusCode::OK);
        assert!(body.contains("name=\"branch\" value=\"feature-x\"") && body.contains("name=\"ticket\" value=\"ticket-1234567890\""));
        // sign-in on that form issues a token whose branch claim is set by the core itself
        let (st, h, _) = send(&c, post_login(&format!("{}&branch=feature-x&ticket=ticket-1234567890", login_body("demo-alice", "demo-only-not-a-secret")))).await;
        assert_eq!(st, StatusCode::FOUND);
        let code = h[header::LOCATION].to_str().unwrap().split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
        let t = Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{VER}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        let (st, _, body) = send(&c, t).await;
        assert_eq!(st, StatusCode::OK);
        let tok: Value = serde_json::from_str(&body).unwrap();
        let claims = iam_idp::verify(tok["id_token"].as_str().unwrap(), &c.idp.jwks(), "http://idp.test").unwrap();
        // no gate in this test core: without the control plane that checks the ticket, no branch is ever bound
        assert!(claims.get("branch").is_none());
    }

    // ---- common frame + theme selector ----

    #[tokio::test]
    async fn theme_endpoint_remembers_the_choice_and_returns_to_the_page() {
        let c = core();
        let back = "/authorize?client_id=demo-web%26x%3D1";
        let req = Request::builder().uri(format!("/authorize/theme?mode=dark&back={back}")).body(Body::empty()).unwrap();
        let (st, h, _) = send(&c, req).await;
        assert_eq!(st, StatusCode::SEE_OTHER);
        assert_eq!(h[header::LOCATION], "/authorize?client_id=demo-web&x=1");
        let cookie = h[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("iam_theme=dark") && cookie.contains("Path=/") && cookie.contains("SameSite=Lax"), "{cookie}");
        // a remembered choice lands on the html element of every framed page
        let req = Request::builder().uri(format!("/authorize?{}", q(""))).header(header::COOKIE, "iam_theme=light").body(Body::empty()).unwrap();
        let (_, _, body) = send(&c, req).await;
        assert!(body.contains("<html lang=\"en\" data-theme=\"light\">"), "{body}");
    }

    #[tokio::test]
    async fn theme_endpoint_never_redirects_away_and_rejects_odd_modes() {
        let c = core();
        for back in ["https%3A%2F%2Fevil.example%2Fx", "%2F%2Fevil.example", "javascript%3Aalert(1)"] {
            let req = Request::builder().uri(format!("/authorize/theme?mode=dark&back={back}")).body(Body::empty()).unwrap();
            let (st, h, _) = send(&c, req).await;
            assert_eq!(st, StatusCode::SEE_OTHER);
            assert_eq!(h[header::LOCATION], "/authorize", "{back}");
        }
        let req = Request::builder().uri("/authorize/theme?mode=blue").body(Body::empty()).unwrap();
        let (_, h, _) = send(&c, req).await;
        assert!(h[header::SET_COOKIE].to_str().unwrap().contains("iam_theme=auto"));
        assert!(h.get(header::CACHE_CONTROL).is_some());
    }

    #[test]
    fn theme_cookie_is_parsed_with_a_safe_default() {
        let parse = |raw: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::COOKIE, HeaderValue::from_str(raw).unwrap());
            theme_of(&h)
        };
        assert_eq!(parse(""), "auto");
        assert_eq!(parse("other=x; iam_theme=dark; more=y"), "dark");
        assert_eq!(parse("iam_theme=blue"), "auto");
        assert_eq!(theme_of(&HeaderMap::new()), "auto");
    }

    #[tokio::test]
    async fn framed_pages_carry_the_common_frame_and_no_script() {
        let c = core();
        let (_, h, body) = send(&c, get(&q(""))).await;
        // default is auto: no data-theme attr, but the selector marks it current
        assert!(body.contains("<html lang=\"en\">"));
        assert!(body.contains("https://picsum.photos/1920/1080"), "background image");
        assert!(body.contains("/authorize/theme?mode=light&amp;back=") && body.contains("/authorize/theme?mode=dark&amp;back="), "theme links");
        assert!(body.contains("aria-current=\"true\""));
        assert!(body.contains("IAM next generation"));
        assert!(body.contains("branding/logo-horizontal-light.svg") && body.contains("branding/logo-horizontal-dark.svg") && body.contains("branding/theme.css"));
        assert!(!body.contains("<script"), "framed pages stay scriptless");
        let csp = h[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("img-src 'self' https://picsum.photos https://fastly.picsum.photos") && !csp.contains("script-src"), "{csp}");
        // the error page is framed too
        let (_, _, body) = send(&c, get(&q("").replace("localhost%3A4200", "evil.example"))).await;
        assert!(body.contains("https://picsum.photos/1920/1080") && body.contains("IAM next generation") && body.contains("Sign-in error"));
        // the theme back link of a step page points at a GET-able authorize URL, never at the session
        let mut p: HashMap<String, String> = HashMap::new();
        p.insert("client_id".into(), "demo-web".into());
        p.insert("state".into(), "s".into());
        let back = authorize_back(&p);
        assert!(back.starts_with("/authorize?response_type=code&") && back.contains("client_id=demo-web"));
    }
}

