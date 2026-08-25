import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const workspacePath = process.cwd();
const parquetPath = join(workspacePath, "cases.parquet");
const publicPath = join(workspacePath, ".github", "extensions", "case-search", "public");
const servers = new Map();
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

function staticFile(pathname) {
    const decodedPath = decodeURIComponent(pathname === "/" ? "/Case Search v2.dc.html" : pathname);
    const filePath = resolve(publicPath, `.${decodedPath}`);
    const pathFromPublic = relative(publicPath, filePath);
    if (pathFromPublic.startsWith("..") || pathFromPublic === "" || !existsSync(filePath)) {
        return null;
    }
    return filePath;
}

const PYTHON_QUERY = String.raw`
import json
import sys
import duckdb

request = json.loads(sys.argv[1])
path = request["path"]
if request["mode"] != "filters" and not __import__("os").path.isfile(path):
    raise RuntimeError("cases.parquet was not found in the repository root.")

con = duckdb.connect(":memory:")
con.execute("CREATE VIEW cases AS SELECT * FROM read_parquet(?)", [path])

if request["mode"] == "filters":
    if not __import__("os").path.isfile(path):
        print(json.dumps({"available": False}))
        sys.exit(0)
    result = {
        "available": True,
        "years": [row[0] for row in con.execute(
            "SELECT DISTINCT year FROM cases WHERE year IS NOT NULL ORDER BY year DESC"
        ).fetchall()],
        "statuses": [row[0] for row in con.execute(
            "SELECT DISTINCT status FROM cases WHERE status IS NOT NULL AND status != '' ORDER BY status"
        ).fetchall()],
        "types": [row[0] for row in con.execute(
            "SELECT DISTINCT case_type FROM cases WHERE case_type IS NOT NULL AND case_type != '' ORDER BY case_type"
        ).fetchall()],
        "officers": [row[0] for row in con.execute(
            "SELECT DISTINCT updated_by FROM cases WHERE updated_by IS NOT NULL AND updated_by != '' ORDER BY updated_by"
        ).fetchall()],
    }
    print(json.dumps(result, default=str))
    sys.exit(0)

clauses = ["1=1"]
params = []
query = request.get("query", "").strip().lower()
if query:
    text = "%" + query + "%"
    clauses.append("""(
        LOWER(COALESCE(CAST(case_number AS VARCHAR), '')) LIKE ?
        OR LOWER(COALESCE(CAST(site_address AS VARCHAR), '')) LIKE ?
        OR LOWER(COALESCE(CAST(owner AS VARCHAR), '')) LIKE ?
        OR LOWER(COALESCE(CAST(updated_by AS VARCHAR), '')) LIKE ?
        OR LOWER(COALESCE(CAST(case_description AS VARCHAR), '')) LIKE ?
        OR LOWER(COALESCE(CAST(case_type AS VARCHAR), '')) LIKE ?
        OR LOWER(COALESCE(CAST(strap AS VARCHAR), '')) LIKE ?
    )""")
    params.extend([text] * 7)
for key, column in (("year", "year"), ("status", "status"), ("type", "case_type"), ("officer", "updated_by")):
    value = request.get(key)
    if value not in (None, ""):
        clauses.append(f"{column} = ?")
        params.append(value)
owner = request.get("owner", "").strip().lower()
if owner:
    for word in owner.split():
        value = "%" + word + "%"
        clauses.append("""(
            LOWER(COALESCE(CAST(owner AS VARCHAR), '')) LIKE ?
            OR LOWER(COALESCE(CAST(owner_other AS VARCHAR), '')) LIKE ?
        )""")
        params.extend([value, value])
origin = request.get("origin")
if origin == "named":
    clauses.append("(UPPER(COALESCE(CAST(case_description AS VARCHAR), '')) LIKE '%PER CP%' OR UPPER(COALESCE(CAST(case_description AS VARCHAR), '')) LIKE '%COMPLAINANT%' OR UPPER(COALESCE(CAST(case_description AS VARCHAR), '')) LIKE '%CALLER%')")
elif origin == "anon":
    clauses.append("UPPER(COALESCE(CAST(case_description AS VARCHAR), '')) LIKE '%ANONYMOUS%'")
elif origin == "neighbor":
    clauses.append("UPPER(COALESCE(CAST(case_description AS VARCHAR), '')) LIKE '%NEIGHBOR%'")
zone_officers = {
    "NE1": "Martin Lehman", "NE2": "Stephanie Folsom", "NE3": "Pam Beesley-Farris",
    "NE4": "Tammy Whitaker", "NE5": "Patrick Hayhurst", "NW1": "Ioulia Scott",
    "NW2": "Jeffrey Colon", "NW3": "Scott Irvin", "NW4": "Sherry Kluczynski",
    "SE1": "Casey Fears", "SE2": "Mark Donisi", "SE3": "Samantha Altman",
    "SE4": "Frank John", "SE5": "Robert Liguori", "SE6": "Thalia Curtis",
    "SW1": "Pete Strainovici", "SW2": "John Williams", "SW3": "Mack Cline",
    "SW4": "Aaron Hurley", "SW5": "Michael Stuff", "SW6": "Jamal Crawford",
    "MC-N": "Eric Speranza", "MC-C": "David Zimmer", "MC-S": "Andrew Wagner",
}
zone = request.get("zone")
if zone in zone_officers:
    clauses.append("LOWER(COALESCE(CAST(updated_by AS VARCHAR), '')) = ?")
    params.append(zone_officers[zone].lower())

where = " AND ".join(clauses)
if request["mode"] == "detail":
    case_number = request["caseNumber"]
    row = con.execute(f"""
        SELECT
            case_number, status, case_type, site_address, owner, owner_other, strap,
            opened, closed, updated_by, case_description, days_to_close, is_open
        FROM cases
        WHERE {where} AND case_number = ?
        LIMIT 1
    """, params + [case_number]).fetchdf()
    print(json.dumps({"case": row.to_dict(orient="records")[0] if not row.empty else None}, default=str))
    sys.exit(0)

summary = con.execute(f"""
    SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_open) AS open_count,
        COUNT(*) FILTER (
            WHERE is_open AND opened IS NOT NULL AND date_diff('day', opened, current_date) > 90
        ) AS aged_count,
        COUNT(DISTINCT updated_by) AS officer_count
    FROM cases
    WHERE {where}
""", params).fetchdf().to_dict(orient="records")[0]
limit = min(max(int(request.get("limit", 200)), 1), 500)
rows = con.execute(f"""
    SELECT
        case_number, site_address, case_type, status, opened, closed, updated_by,
        days_to_close, is_open, owner, strap, case_description
    FROM cases
    WHERE {where}
    ORDER BY opened DESC NULLS LAST
    LIMIT ?
""", params + [limit]).fetchdf().to_dict(orient="records")
print(json.dumps({"summary": summary, "rows": rows}, default=str))
`;

async function queryCases(request) {
    if (!existsSync(parquetPath)) {
        throw new CanvasError(
            "data_unavailable",
            "cases.parquet is required in the repository root before the case search can query records.",
        );
    }

    try {
        const { stdout } = await execFileAsync(
            "python",
            ["-c", PYTHON_QUERY, JSON.stringify({ ...request, path: parquetPath })],
            { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
    } catch (error) {
        const message = error.stderr?.trim() || error.message;
        throw new CanvasError("query_failed", `Unable to query case data: ${message}`);
    }
}

function renderHtml(initialQuery) {
    const state = JSON.stringify({ query: initialQuery ?? "" }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cape Coral Code Watch</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--background-color-default, #0d1117); color: var(--text-color-default, #f0f6fc); font: var(--text-body-medium, 14px)/var(--leading-body-medium, 1.5) var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
    button, input, select { font: inherit; }
    .app { height: 100vh; display: flex; flex-direction: column; }
    header { width: 100%; max-width: 1120px; margin: 0 auto; padding: 18px 24px 12px; background: var(--background-color-default, #0d1117); }
    .title-row, .summary { display: flex; align-items: center; gap: 12px; }
    .nav { display: flex; flex-wrap: wrap; gap: 17px; margin-bottom: 52px; color: var(--text-color-muted, #8b949e); font-size: 12px; }
    .nav strong { color: var(--true-color-blue, #58a6ff); font-weight: 500; }
    .hero { max-width: 760px; }
    .hero h1 { margin: 0; font-size: clamp(24px, 3vw, 30px); line-height: 1.2; letter-spacing: -.02em; }
    .hero p { max-width: 660px; margin: 8px 0 18px; color: var(--text-color-muted, #8b949e); font-size: 14.5px; line-height: 1.55; }
    .live { display: inline-block; margin-left: 8px; padding: 2px 7px; border: 1px solid var(--border-color-default, #30363d); border-radius: 999px; color: var(--true-color-blue, #58a6ff); font-size: 11px; vertical-align: middle; }
    .subtitle, .muted { color: var(--text-color-muted, #8b949e); font-size: 12px; }
    .spacer { flex: 1; }
    input, select { min-height: 34px; border: 1px solid var(--border-color-default, #30363d); border-radius: 6px; padding: 6px 9px; color: inherit; background: var(--background-color-default, #0d1117); }
    #search { width: 100%; padding-left: 34px; font-size: 15px; }
    .search-wrap { position: relative; margin: 14px 0 10px; }
    .search-icon { position: absolute; left: 11px; top: 8px; color: var(--text-color-muted, #8b949e); }
    button { min-height: 32px; border: 1px solid var(--border-color-default, #30363d); border-radius: 6px; padding: 5px 10px; color: inherit; background: transparent; cursor: pointer; }
    button:hover { border-color: var(--color-focus-outline, #58a6ff); }
    button.primary { color: #fff; border-color: #1f6feb; background: #1f6feb; }
    .summary { min-height: 28px; padding-top: 10px; }
    .filter-row { display: none; align-items: center; gap: 12px; margin-top: 12px; padding: 16px; border: 1px solid var(--border-color-default, #30363d); border-radius: 8px; background: color-mix(in srgb, var(--background-color-default, #0d1117) 88%, var(--color-white, #fff)); }
    .filter-row.open { display: flex; flex-wrap: wrap; }
    .stat { margin-left: 12px; color: var(--text-color-muted, #8b949e); font-size: 12px; }
    .stat strong { color: var(--text-color-default, #f0f6fc); }
    main { min-height: 0; flex: 1; display: flex; }
    .results { min-width: 0; flex: 1; overflow: auto; padding: 0 24px 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { position: sticky; top: 0; padding: 11px 7px; text-align: left; background: var(--background-color-default, #0d1117); color: var(--text-color-muted, #8b949e); font-weight: 500; }
    td { border-top: 1px solid var(--border-color-default, #30363d); padding: 10px 7px; vertical-align: top; }
    tbody tr { cursor: pointer; }
    tbody tr:hover, tbody tr.selected { background: color-mix(in srgb, var(--true-color-blue-muted, #388bfd) 12%, transparent); }
    .case-number { color: var(--true-color-blue, #58a6ff); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .tag { display: inline-block; max-width: 145px; overflow: hidden; text-overflow: ellipsis; padding: 2px 7px; border: 1px solid var(--border-color-default, #30363d); border-radius: 999px; white-space: nowrap; font-size: 11px; }
    .tag.open { border-color: color-mix(in srgb, var(--true-color-blue, #58a6ff) 55%, transparent); color: var(--true-color-blue, #58a6ff); }
    aside { width: 360px; overflow: auto; padding: 20px 24px; border-left: 1px solid var(--border-color-default, #30363d); background: color-mix(in srgb, var(--background-color-default, #0d1117) 92%, var(--color-white, #fff)); }
    aside[hidden] { display: none; }
    .detail-title { margin: 0; font-size: 21px; }
    .detail-type { margin: 4px 0 16px; color: var(--true-color-blue, #58a6ff); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    dl { display: grid; grid-template-columns: 82px 1fr; gap: 9px 12px; font-size: 13px; }
    dt { color: var(--text-color-muted, #8b949e); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .description { margin-top: 22px; border-top: 1px solid var(--border-color-default, #30363d); padding-top: 16px; white-space: pre-wrap; }
    .empty { padding: 48px 0; color: var(--text-color-muted, #8b949e); }
    .error { margin: 18px 24px; padding: 12px; border: 1px solid var(--true-color-red, #f85149); border-radius: 6px; color: var(--true-color-red, #f85149); }
    @media (max-width: 850px) { header, .results { padding-left: 14px; padding-right: 14px; } .nav { margin-bottom: 32px; gap: 11px; } aside { position: fixed; inset: 0 0 0 12%; width: auto; z-index: 2; box-shadow: -8px 0 24px #0006; } .filter-row { align-items: stretch; flex-wrap: wrap; } .filter-row select { flex: 1 1 40%; } th:nth-child(3), td:nth-child(3), th:nth-child(6), td:nth-child(6), th:nth-child(7), td:nth-child(7) { display: none; } }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <nav class="nav"><strong>Code enforcement cases</strong><span>Officers</span><span>Planning projects</span><span>Contractors</span><span>Building permits</span><span>Inspections</span><span>Parcel map</span><span>Public works</span><span>Salaries</span></nav>
      <div class="hero"><h1>Cape Coral Code Enforcement Case Search <span class="live">Live</span></h1><p>Look up the code enforcement history of any property in the city. Search the public record by address, owner, case number, officer, description, or parcel.</p></div>
      <div class="title-row"><span class="subtitle" id="total-label">Loading case data…</span><span class="spacer"></span><button id="export">Export CSV</button></div>
      <div class="search-wrap"><span class="search-icon">⌕</span><input id="search" autocomplete="off" placeholder="4934 SW 20th Pl, Zubek, CODE22-017213, 164523C1046410330…"></div>
      <div class="filter-row">
        <select id="year"><option value="">All years</option></select>
        <select id="status"><option value="">All statuses</option></select>
        <select id="type"><option value="">All case types</option></select>
        <select id="officer"><option value="">Updated by — anyone</option></select>
        <select id="origin"><option value="">Who reported it — anyone</option><option value="named">Named complainant</option><option value="anon">Anonymous</option><option value="neighbor">Neighbor</option></select>
        <input id="owner" autocomplete="off" placeholder="Owner name">
        <select id="zone"><option value="">Any enforcement zone</option><option value="NE1">NE1</option><option value="NE2">NE2</option><option value="NE3">NE3</option><option value="NE4">NE4</option><option value="NE5">NE5</option><option value="NW1">NW1</option><option value="NW2">NW2</option><option value="NW3">NW3</option><option value="NW4">NW4</option><option value="SE1">SE1</option><option value="SE2">SE2</option><option value="SE3">SE3</option><option value="SE4">SE4</option><option value="SE5">SE5</option><option value="SE6">SE6</option><option value="SW1">SW1</option><option value="SW2">SW2</option><option value="SW3">SW3</option><option value="SW4">SW4</option><option value="SW5">SW5</option><option value="SW6">SW6</option><option value="MC-N">MC-N</option><option value="MC-C">MC-C</option><option value="MC-S">MC-S</option></select>
      </div>
      <div class="summary"><button id="toggle-filters">Filters</button><button id="clear">Clear all</button><span class="muted" id="count-label"></span><span class="spacer"></span><span class="stat">Open <strong id="open-count">—</strong></span><span class="stat">Over 90 days <strong id="aged-count">—</strong></span><span class="stat">Officers <strong id="officer-count">—</strong></span></div>
    </header>
    <div id="error" class="error" hidden></div>
    <main>
      <div class="results">
        <table><thead><tr><th>Case</th><th>Address</th><th>Case type</th><th>Status</th><th>Opened</th><th>Closed</th><th>Updated by</th><th>Days</th></tr></thead><tbody id="rows"></tbody></table>
        <div class="empty" id="empty" hidden>No matching cases. Try a shorter search term or clear a filter.</div>
      </div>
      <aside id="detail" hidden></aside>
    </main>
  </div>
  <script>
    const state = ${state};
    const fields = ["year", "status", "type", "officer", "origin", "owner", "zone"];
    const search = document.querySelector("#search");
    let rows = [];
    const esc = value => String(value ?? "—");
    const fmt = value => value ? String(value).replace("T", " ").slice(0, 16) : "—";
    const statusClass = value => /open|pending/i.test(value ?? "") ? "open" : "";
    const payload = () => ({ query: search.value, ...Object.fromEntries(fields.map(key => [key, document.querySelector("#" + key).value])) });
    function showError(message) { const el = document.querySelector("#error"); el.textContent = message; el.hidden = false; }
    function clearError() { document.querySelector("#error").hidden = true; }
    function options(id, values) { const select = document.querySelector("#" + id); values.forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); }); }
    function render(result) {
      clearError();
      rows = result.rows ?? [];
      const summary = result.summary ?? {};
      document.querySelector("#total-label").textContent = (summary.total ?? 0).toLocaleString() + " cases";
      document.querySelector("#count-label").textContent = search.value.trim() ? "Showing the most recent " + rows.length.toLocaleString() + " matching records" : "Recently opened citywide";
      document.querySelector("#open-count").textContent = (summary.open_count ?? 0).toLocaleString();
      document.querySelector("#aged-count").textContent = (summary.aged_count ?? 0).toLocaleString();
      document.querySelector("#officer-count").textContent = (summary.officer_count ?? 0).toLocaleString();
      const body = document.querySelector("#rows"); body.replaceChildren();
      rows.forEach((row, index) => {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td class='case-number'></td><td></td><td></td><td><span class='tag'></span></td><td></td><td></td><td></td><td style='text-align:right'></td>";
        const cells = tr.children;
        cells[0].textContent = esc(row.case_number); cells[1].textContent = esc(row.site_address); cells[2].textContent = esc(row.case_type);
        cells[3].firstChild.textContent = esc(row.status); cells[3].firstChild.classList.add(statusClass(row.status));
        cells[4].textContent = fmt(row.opened); cells[5].textContent = fmt(row.closed); cells[6].textContent = esc(row.updated_by); cells[7].textContent = esc(row.days_to_close);
        tr.addEventListener("click", () => selectCase(index, tr)); body.append(tr);
      });
      document.querySelector("#empty").hidden = rows.length !== 0;
    }
    async function load() {
      try {
        const response = await fetch("/api/search", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload()) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error); render(result);
      } catch (error) { showError(error.message); }
    }
    async function selectCase(index, tr) {
      document.querySelectorAll("tbody tr").forEach(element => element.classList.remove("selected")); tr.classList.add("selected");
      const row = rows[index]; const detail = document.querySelector("#detail");
      detail.hidden = false; detail.textContent = "Loading case detail…";
      try {
        const response = await fetch("/api/detail", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({...payload(), caseNumber: row.case_number}) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error);
        const item = result.case; if (!item) throw new Error("The selected case is no longer available.");
        detail.replaceChildren();
        const close = document.createElement("button"); close.textContent = "Close"; close.style.float = "right"; close.onclick = () => { detail.hidden = true; };
        const title = document.createElement("h2"); title.className = "detail-title"; title.textContent = esc(item.case_number);
        const type = document.createElement("div"); type.className = "detail-type"; type.textContent = esc(item.case_type);
        const tag = document.createElement("span"); tag.className = "tag " + statusClass(item.status); tag.textContent = esc(item.status);
        const list = document.createElement("dl");
        [["Address", item.site_address], ["Owner", item.owner], ["Other owner", item.owner_other], ["STRAP", item.strap], ["Opened", fmt(item.opened)], ["Closed", fmt(item.closed)], ["Updated by", item.updated_by], ["Resolution", item.days_to_close ? item.days_to_close + " days" : "—"]].forEach(([key, value]) => { const dt = document.createElement("dt"); const dd = document.createElement("dd"); dt.textContent = key; dd.textContent = esc(value); list.append(dt, dd); });
        const description = document.createElement("div"); description.className = "description"; description.textContent = item.case_description || "No description recorded.";
        detail.append(close, title, type, tag, list, description);
      } catch (error) { detail.textContent = error.message; }
    }
    async function loadFilters() {
      try {
        const response = await fetch("/api/filters"); const result = await response.json();
        if (!response.ok || !result.available) throw new Error("cases.parquet is required in the repository root to search public records.");
        options("year", result.years); options("status", result.statuses); options("type", result.types); options("officer", result.officers);
        search.value = state.query; load();
      } catch (error) { showError(error.message); document.querySelector("#total-label").textContent = "Case data unavailable"; }
    }
    let timer; search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    fields.forEach(key => document.querySelector("#" + key).addEventListener("change", load));
    document.querySelector("#owner").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    document.querySelector("#toggle-filters").addEventListener("click", () => document.querySelector(".filter-row").classList.toggle("open"));
    document.querySelector("#clear").addEventListener("click", () => { search.value = ""; fields.forEach(key => document.querySelector("#" + key).value = ""); document.querySelector("#detail").hidden = true; load(); });
    document.querySelector("#export").addEventListener("click", () => {
      const header = ["case_number","site_address","case_type","status","opened","closed","updated_by","days_to_close"];
      const quote = value => '"' + String(value ?? "").replaceAll('"', '""') + '"';
      const csv = [header.join(","), ...rows.map(row => header.map(key => quote(row[key])).join(","))].join("\\n");
      const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"})); link.download = "cape-coral-code-cases.csv"; link.click(); URL.revokeObjectURL(link.href);
    });
    loadFilters();
  </script>
</body>
</html>`;
}

async function startServer(initialQuery) {
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        const filePath = request.method === "GET" ? staticFile(url.pathname) : null;
        if (filePath) {
            response.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
            response.end(readFileSync(filePath));
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/filters") {
            try {
                const result = existsSync(parquetPath)
                    ? await queryCases({ mode: "filters" })
                    : { available: false };
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(result));
            } catch (error) {
                response.writeHead(500, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: error.message }));
            }
            return;
        }

        if (request.method === "POST" && (url.pathname === "/api/search" || url.pathname === "/api/detail")) {
            let body = "";
            for await (const chunk of request) body += chunk;
            try {
                const input = JSON.parse(body || "{}");
                const result = await queryCases({
                    ...input,
                    mode: url.pathname === "/api/detail" ? "detail" : "search",
                });
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(result));
            } catch (error) {
                response.writeHead(error instanceof CanvasError ? 503 : 400, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: error.message }));
            }
            return;
        }

        response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { server, url: `http://127.0.0.1:${address.port}/` };
}

await joinSession({
    canvases: [
        createCanvas({
            id: "case-search",
            displayName: "Cape Coral Case Search",
            description: "Search and inspect Cape Coral code enforcement records from the repository's cases.parquet data.",
            inputSchema: {
                type: "object",
                properties: { query: { type: "string", maxLength: 200 } },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "search",
                    description: "Search code-enforcement cases using the same filters available in the canvas.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string", maxLength: 200 },
                            year: { type: ["string", "integer"] },
                            status: { type: "string", maxLength: 200 },
                            type: { type: "string", maxLength: 200 },
                            officer: { type: "string", maxLength: 200 },
                            origin: { type: "string", enum: ["named", "anon", "neighbor"] },
                            owner: { type: "string", maxLength: 200 },
                            zone: { type: "string", maxLength: 4 },
                            limit: { type: "integer", minimum: 1, maximum: 500 },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => queryCases({ mode: "search", ...(ctx.input ?? {}) }),
                },
                {
                    name: "get_case",
                    description: "Retrieve full detail for a code-enforcement case number.",
                    inputSchema: {
                        type: "object",
                        properties: { caseNumber: { type: "string", minLength: 1, maxLength: 200 } },
                        required: ["caseNumber"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => queryCases({ mode: "detail", ...(ctx.input ?? {}) }),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.input?.query ?? "");
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: "Cape Coral Case Search",
                    url: `${entry.url}Case%20Search%20v2.dc.html`,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(resolve));
                }
            },
        }),
    ],
});
