"""
Cape Coral Code Watch
Mobile-friendly Streamlit accountability tool for code enforcement cases.
Optimized for iPhone / small screens.
"""

import streamlit as st
import duckdb
import pandas as pd
import plotly.express as px
from datetime import datetime
from pathlib import Path

# -----------------------------------------------------------------------------
# Config & Page
# -----------------------------------------------------------------------------
st.set_page_config(
    page_title="Cape Coral Code Watch",
    page_icon="⚖️",
    layout="wide",
    initial_sidebar_state="collapsed",  # better default for phones
)

PARQUET_PATH = Path(__file__).parent / "cases.parquet"

# -----------------------------------------------------------------------------
# Data layer (DuckDB)
# -----------------------------------------------------------------------------
@st.cache_resource
def get_connection():
    con = duckdb.connect(database=":memory:")
    con.execute(f"CREATE VIEW cases AS SELECT * FROM '{PARQUET_PATH}'")
    return con


@st.cache_data(ttl=3600, show_spinner=False)
def get_filter_options():
    con = get_connection()
    years = con.execute("SELECT MIN(year), MAX(year) FROM cases").fetchone()
    statuses = [r[0] for r in con.execute(
        "SELECT status FROM cases GROUP BY 1 ORDER BY COUNT(*) DESC"
    ).fetchall()]
    case_types = [r[0] for r in con.execute(
        "SELECT case_type FROM cases WHERE case_type IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC"
    ).fetchall()]
    zips = [r[0] for r in con.execute(
        "SELECT zip FROM cases WHERE zip IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC"
    ).fetchall()]
    return {
        "year_min": int(years[0]),
        "year_max": int(years[1]),
        "statuses": statuses,
        "case_types": case_types,
        "zips": zips,
    }


def build_where_clause(search, year_range, statuses, case_types, zips, open_only):
    clauses = []
    params = []

    if search and search.strip():
        q = f"%{search.strip().lower()}%"
        clauses.append("""
            (LOWER(COALESCE(case_number,'')) LIKE ?
             OR LOWER(COALESCE(site_address,'')) LIKE ?
             OR LOWER(COALESCE(site_addr_raw,'')) LIKE ?
             OR LOWER(COALESCE(owner,'')) LIKE ?
             OR LOWER(COALESCE(owner_other,'')) LIKE ?
             OR LOWER(COALESCE(case_description,'')) LIKE ?
             OR LOWER(COALESCE(parcel_id,'')) LIKE ?
             OR LOWER(COALESCE(strap,'')) LIKE ?)
        """)
        params.extend([q] * 8)

    if year_range:
        clauses.append("year BETWEEN ? AND ?")
        params.extend([year_range[0], year_range[1]])

    if statuses:
        placeholders = ",".join(["?"] * len(statuses))
        clauses.append(f"status IN ({placeholders})")
        params.extend(statuses)

    if case_types:
        placeholders = ",".join(["?"] * len(case_types))
        clauses.append(f"case_type IN ({placeholders})")
        params.extend(case_types)

    if zips:
        placeholders = ",".join(["?"] * len(zips))
        clauses.append(f"zip IN ({placeholders})")
        params.extend(zips)

    if open_only:
        clauses.append("is_open = TRUE")

    where = " AND ".join(clauses) if clauses else "1=1"
    return where, params


@st.cache_data(ttl=300, show_spinner="Querying cases…")
def query_cases(search, year_range, statuses, case_types, zips, open_only, limit=2000):
    con = get_connection()
    where, params = build_where_clause(search, year_range, statuses, case_types, zips, open_only)

    sql = f"""
        SELECT
            case_number, status, opened, closed, days_to_close,
            case_type, case_subtype, site_address, zip, owner, owner_other,
            updated_by, case_description, parcel_id, strap, year, is_open
        FROM cases
        WHERE {where}
        ORDER BY opened DESC
        LIMIT {limit}
    """
    return con.execute(sql, params).fetchdf()


@st.cache_data(ttl=300, show_spinner=False)
def query_metrics(search, year_range, statuses, case_types, zips, open_only):
    con = get_connection()
    where, params = build_where_clause(search, year_range, statuses, case_types, zips, open_only)

    sql = f"""
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE is_open) as open_cases,
            ROUND(AVG(days_to_close) FILTER (WHERE days_to_close IS NOT NULL), 1) as avg_days,
            COUNT(DISTINCT site_address) as unique_addresses,
            COUNT(DISTINCT owner) as unique_owners
        FROM cases
        WHERE {where}
    """
    return con.execute(sql, params).fetchone()


@st.cache_data(ttl=300, show_spinner=False)
def query_aggregates(search, year_range, statuses, case_types, zips, open_only):
    con = get_connection()
    where, params = build_where_clause(search, year_range, statuses, case_types, zips, open_only)

    by_year = con.execute(f"""
        SELECT year, COUNT(*) as cases
        FROM cases WHERE {where}
        GROUP BY year ORDER BY year
    """, params).fetchdf()

    by_type = con.execute(f"""
        SELECT case_type, COUNT(*) as cases
        FROM cases WHERE {where} AND case_type IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    """, params).fetchdf()

    by_status = con.execute(f"""
        SELECT status, COUNT(*) as cases
        FROM cases WHERE {where}
        GROUP BY 1 ORDER BY 2 DESC
    """, params).fetchdf()

    by_officer = con.execute(f"""
        SELECT updated_by as officer, COUNT(*) as cases,
               ROUND(AVG(days_to_close) FILTER (WHERE days_to_close IS NOT NULL), 1) as avg_days
        FROM cases WHERE {where} AND updated_by IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 15
    """, params).fetchdf()

    top_addresses = con.execute(f"""
        SELECT site_address, zip, COUNT(*) as cases,
               COUNT(*) FILTER (WHERE is_open) as open_now,
               MAX(opened) as last_case
        FROM cases WHERE {where} AND site_address IS NOT NULL
        GROUP BY 1, 2
        HAVING COUNT(*) >= 3
        ORDER BY 3 DESC LIMIT 25
    """, params).fetchdf()

    top_owners = con.execute(f"""
        SELECT owner, COUNT(*) as cases,
               COUNT(DISTINCT site_address) as properties,
               COUNT(*) FILTER (WHERE is_open) as open_now
        FROM cases WHERE {where} AND owner IS NOT NULL AND owner != ''
        GROUP BY 1
        HAVING COUNT(*) >= 5
        ORDER BY 2 DESC LIMIT 25
    """, params).fetchdf()

    by_zip = con.execute(f"""
        SELECT zip, COUNT(*) as cases
        FROM cases WHERE {where} AND zip IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC
    """, params).fetchdf()

    return {
        "by_year": by_year,
        "by_type": by_type,
        "by_status": by_status,
        "by_officer": by_officer,
        "top_addresses": top_addresses,
        "top_owners": top_owners,
        "by_zip": by_zip,
    }


# -----------------------------------------------------------------------------
# UI Helpers
# -----------------------------------------------------------------------------
def inject_css():
    st.markdown("""
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    html, body, [class*="css"] {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        -webkit-text-size-adjust: 100%;
    }

    /* Header */
    .main-header {
        background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%);
        padding: 1.1rem 1.25rem;
        border-radius: 12px;
        margin-bottom: 1rem;
        color: white;
        border: 1px solid #334155;
    }
    .main-header h1 {
        margin: 0;
        font-size: 1.45rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.25;
    }
    .main-header p {
        margin: 0.3rem 0 0 0;
        opacity: 0.85;
        font-size: 0.82rem;
        line-height: 1.35;
    }

    /* Metrics */
    div[data-testid="stMetric"] {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 0.7rem 0.85rem;
    }
    div[data-testid="stMetric"] label {
        color: #64748b !important;
        font-size: 0.72rem !important;
        font-weight: 500 !important;
    }
    div[data-testid="stMetric"] [data-testid="stMetricValue"] {
        font-size: 1.35rem !important;
        font-weight: 700 !important;
        color: #0f172a !important;
    }

    /* Case cards (mobile-friendly) */
    .case-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 0.9rem 1rem;
        margin-bottom: 0.7rem;
        box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .badge {
        display: inline-block;
        padding: 0.18rem 0.55rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        margin-right: 0.35rem;
    }
    .badge-open { background: #fef3c7; color: #92400e; }
    .badge-closed { background: #d1fae5; color: #065f46; }
    .badge-type { background: #e0e7ff; color: #3730a3; }

    /* Tabs */
    .stTabs [data-baseweb="tab-list"] {
        gap: 4px;
        flex-wrap: wrap;
    }
    .stTabs [data-baseweb="tab"] {
        border-radius: 8px;
        padding: 0.4rem 0.75rem;
        font-weight: 500;
        font-size: 0.85rem;
    }

    /* Mobile overrides */
    @media (max-width: 768px) {
        .main-header {
            padding: 0.9rem 1rem;
            margin-bottom: 0.85rem;
        }
        .main-header h1 {
            font-size: 1.25rem;
        }
        .main-header p {
            font-size: 0.78rem;
        }
        div[data-testid="stMetric"] [data-testid="stMetricValue"] {
            font-size: 1.2rem !important;
        }
        [data-testid="stSidebar"] {
            min-width: 280px !important;
        }
        .js-plotly-plot {
            margin-bottom: 0.5rem !important;
        }
        .block-container {
            padding-top: 1rem !important;
            padding-left: 0.75rem !important;
            padding-right: 0.75rem !important;
        }
    }

    footer { visibility: hidden; }
    #MainMenu { visibility: hidden; }

    .stButton > button, .stDownloadButton > button {
        min-height: 2.6rem;
        border-radius: 8px;
        font-weight: 500;
    }
    </style>
    """, unsafe_allow_html=True)


def status_badge(status, is_open):
    if is_open:
        return '<span class="badge badge-open">OPEN</span>'
    return f'<span class="badge badge-closed">{status}</span>'


# -----------------------------------------------------------------------------
# Main App
# -----------------------------------------------------------------------------
def main():
    inject_css()

    # Header
    st.markdown("""
    <div class="main-header">
        <h1>⚖️ Cape Coral Code Watch</h1>
        <p>Public accountability · Code enforcement · ~647k cases · 2000–2026</p>
    </div>
    """, unsafe_allow_html=True)

    opts = get_filter_options()

    # ----- Primary filters (always visible — critical for phone) -----
    search = st.text_input(
        "Search address, owner, case #, parcel, or keyword",
        placeholder="e.g. 123 SE 15th, Smith, CODE23-…",
        help="Searches case number, address, owner, description, parcel/STRAP",
    )

    col_y, col_open = st.columns([3, 1])
    with col_y:
        year_range = st.slider(
            "Year opened",
            min_value=opts["year_min"],
            max_value=opts["year_max"],
            value=(2018, opts["year_max"]),
            step=1,
        )
    with col_open:
        st.write("")  # spacer
        open_only = st.checkbox("Open only", value=False)

    # Advanced filters live in the sidebar (hamburger on phone)
    with st.sidebar:
        st.markdown("### More filters")
        statuses = st.multiselect(
            "Status",
            options=opts["statuses"],
            default=None,
        )
        case_types = st.multiselect(
            "Case Type",
            options=opts["case_types"],
            default=None,
        )
        zips = st.multiselect(
            "ZIP Code",
            options=opts["zips"],
            default=None,
        )
        st.divider()
        st.caption("Independent public-records tool. Not affiliated with the City of Cape Coral.")

    # ----- Query -----
    metrics = query_metrics(search, year_range, statuses, case_types, zips, open_only)
    total, open_cases, avg_days, uniq_addr, uniq_owners = metrics

    # KPI row — 2 columns on mobile via Streamlit’s responsive behavior
    m1, m2 = st.columns(2)
    m1.metric("Matching Cases", f"{total:,}")
    m2.metric("Currently Open", f"{open_cases:,}")
    m3, m4 = st.columns(2)
    m3.metric("Avg Days to Close", f"{avg_days or '—'}")
    m4.metric("Unique Addresses", f"{uniq_addr:,}")

    st.divider()

    # ----- Tabs -----
    tab_overview, tab_cases, tab_analytics, tab_repeats, tab_about = st.tabs(
        ["Overview", "Cases", "Analytics", "Repeats", "About"]
    )

    aggs = query_aggregates(search, year_range, statuses, case_types, zips, open_only)

    # ===== OVERVIEW =====
    with tab_overview:
        st.subheader("Cases by Year")
        if not aggs["by_year"].empty:
            fig = px.bar(
                aggs["by_year"],
                x="year",
                y="cases",
                labels={"year": "Year", "cases": "Cases"},
                color_discrete_sequence=["#1e40af"],
            )
            fig.update_layout(
                margin=dict(l=10, r=10, t=20, b=10),
                height=280,
                xaxis=dict(dtick=2),
                plot_bgcolor="rgba(0,0,0,0)",
                paper_bgcolor="rgba(0,0,0,0)",
                font=dict(size=11),
            )
            st.plotly_chart(fig, use_container_width=True)
        else:
            st.info("No data for current filters.")

        st.subheader("Top Violation Types")
        if not aggs["by_type"].empty:
            fig2 = px.bar(
                aggs["by_type"].sort_values("cases"),
                x="cases",
                y="case_type",
                orientation="h",
                labels={"cases": "Cases", "case_type": ""},
                color_discrete_sequence=["#0f766e"],
            )
            fig2.update_layout(
                margin=dict(l=10, r=10, t=10, b=10),
                height=360,
                plot_bgcolor="rgba(0,0,0,0)",
                paper_bgcolor="rgba(0,0,0,0)",
                yaxis=dict(categoryorder="total ascending"),
                font=dict(size=11),
            )
            st.plotly_chart(fig2, use_container_width=True)

        st.subheader("Status Breakdown")
        if not aggs["by_status"].empty:
            fig3 = px.pie(
                aggs["by_status"],
                names="status",
                values="cases",
                hole=0.42,
                color_discrete_sequence=px.colors.qualitative.Set2,
            )
            fig3.update_layout(
                margin=dict(l=10, r=10, t=20, b=10),
                height=300,
                showlegend=True,
                legend=dict(orientation="h", y=-0.2, font=dict(size=10)),
                font=dict(size=11),
            )
            st.plotly_chart(fig3, use_container_width=True)

        st.subheader("Cases by ZIP")
        if not aggs["by_zip"].empty:
            figz = px.bar(
                aggs["by_zip"].head(8),
                x="zip",
                y="cases",
                color_discrete_sequence=["#7c3aed"],
            )
            figz.update_layout(
                margin=dict(l=10, r=10, t=10, b=10),
                height=260,
                plot_bgcolor="rgba(0,0,0,0)",
                paper_bgcolor="rgba(0,0,0,0)",
                font=dict(size=11),
            )
            st.plotly_chart(figz, use_container_width=True)

    # ===== CASES =====
    with tab_cases:
        st.caption(f"Up to 2,000 most recent · {total:,} total match filters")
        df = query_cases(search, year_range, statuses, case_types, zips, open_only, limit=2000)

        if df.empty:
            st.warning("No cases match the current filters.")
        else:
            csv = df.to_csv(index=False).encode("utf-8")
            st.download_button(
                "Download filtered CSV",
                data=csv,
                file_name=f"cape_coral_cases_{datetime.now().strftime('%Y%m%d')}.csv",
                mime="text/csv",
            )

            view_mode = st.radio(
                "View",
                ["Cards (phone-friendly)", "Table"],
                horizontal=True,
                label_visibility="collapsed",
            )

            if view_mode.startswith("Cards"):
                # Card view — far better on iPhone
                show_n = st.slider("How many cards to show", 5, 40, 12, 1)
                for _, row in df.head(show_n).iterrows():
                    opened_str = row["opened"].strftime("%Y-%m-%d") if pd.notna(row["opened"]) else "—"
                    closed_str = row["closed"].strftime("%Y-%m-%d") if pd.notna(row["closed"]) else "—"
                    days = row["days_to_close"] if pd.notna(row["days_to_close"]) else "—"
                    st.markdown(f"""
                    <div class="case-card">
                        <div style="margin-bottom:0.4rem;">
                            <strong>{row['case_number']}</strong>
                            {status_badge(row['status'], row['is_open'])}
                            <span class="badge badge-type">{row['case_type'] or '—'}</span>
                        </div>
                        <div style="font-size:0.9rem; line-height:1.45; color:#1e293b;">
                            <div><strong>📍</strong> {row['site_address'] or '—'} · {row['zip'] or ''}</div>
                            <div><strong>👤</strong> {row['owner'] or '—'}</div>
                            <div style="margin-top:0.25rem; color:#64748b; font-size:0.82rem;">
                                Opened {opened_str} · Closed {closed_str} · {days} days
                            </div>
                        </div>
                    </div>
                    """, unsafe_allow_html=True)

                # Detail for one case
                st.markdown("---")
                st.subheader("Full case detail")
                selected = st.selectbox(
                    "Pick a case",
                    options=df["case_number"].tolist()[:100],
                    label_visibility="collapsed",
                )
                if selected:
                    row = df[df["case_number"] == selected].iloc[0]
                    st.markdown(f"""
                    <div class="case-card">
                        <div style="margin-bottom:0.5rem;">
                            <strong style="font-size:1.05rem;">{row['case_number']}</strong>
                            {status_badge(row['status'], row['is_open'])}
                            <span class="badge badge-type">{row['case_type'] or '—'}</span>
                        </div>
                        <p style="margin:0.2rem 0;"><strong>Address:</strong> {row['site_address'] or '—'}</p>
                        <p style="margin:0.2rem 0;"><strong>Owner:</strong> {row['owner'] or '—'}
                        {f" / {row['owner_other']}" if pd.notna(row.get('owner_other')) and str(row.get('owner_other')) not in ('','nan') else ''}</p>
                        <p style="margin:0.2rem 0;"><strong>Opened:</strong> {row['opened'].strftime('%Y-%m-%d %H:%M') if pd.notna(row['opened']) else '—'}
                        · <strong>Closed:</strong> {row['closed'].strftime('%Y-%m-%d %H:%M') if pd.notna(row['closed']) else '—'}</p>
                        <p style="margin:0.2rem 0;"><strong>Officer:</strong> {row['updated_by'] or '—'}</p>
                        <p style="margin:0.2rem 0;"><strong>Parcel:</strong> {row['parcel_id'] or '—'} / {row['strap'] or '—'}</p>
                        <hr style="border:none; border-top:1px solid #e2e8f0; margin:0.6rem 0;">
                        <p style="margin:0; font-size:0.9rem; color:#334155;"><strong>Description</strong><br>
                        {row['case_description'] or 'No description.'}</p>
                    </div>
                    """, unsafe_allow_html=True)

            else:
                # Classic table
                display_cols = [
                    "case_number", "status", "opened", "case_type",
                    "site_address", "zip", "owner", "days_to_close"
                ]
                st.dataframe(
                    df[display_cols],
                    use_container_width=True,
                    height=420,
                    column_config={
                        "opened": st.column_config.DatetimeColumn("Opened", format="YYYY-MM-DD"),
                        "days_to_close": st.column_config.NumberColumn("Days"),
                        "case_number": st.column_config.TextColumn("Case #"),
                        "site_address": st.column_config.TextColumn("Address"),
                    },
                )

    # ===== ANALYTICS =====
    with tab_analytics:
        st.subheader("Officer Activity")
        if not aggs["by_officer"].empty:
            fig_off = px.bar(
                aggs["by_officer"].sort_values("cases"),
                x="cases",
                y="officer",
                orientation="h",
                hover_data=["avg_days"],
                labels={"cases": "Cases", "officer": "", "avg_days": "Avg days"},
                color="avg_days",
                color_continuous_scale="Teal",
            )
            fig_off.update_layout(
                margin=dict(l=10, r=10, t=10, b=10),
                height=420,
                plot_bgcolor="rgba(0,0,0,0)",
                paper_bgcolor="rgba(0,0,0,0)",
                yaxis=dict(categoryorder="total ascending"),
                font=dict(size=11),
            )
            st.plotly_chart(fig_off, use_container_width=True)
            st.caption("Color = average days to close")
        else:
            st.info("No officer data for current filters.")

        st.subheader("Days to Close")
        con = get_connection()
        where, params = build_where_clause(search, year_range, statuses, case_types, zips, open_only)
        days_df = con.execute(f"""
            SELECT days_to_close
            FROM cases
            WHERE {where} AND days_to_close IS NOT NULL AND days_to_close BETWEEN 0 AND 730
        """, params).fetchdf()
        if not days_df.empty:
            fig_hist = px.histogram(
                days_df,
                x="days_to_close",
                nbins=35,
                labels={"days_to_close": "Days to close"},
                color_discrete_sequence=["#0369a1"],
            )
            fig_hist.update_layout(
                margin=dict(l=10, r=10, t=10, b=10),
                height=280,
                plot_bgcolor="rgba(0,0,0,0)",
                paper_bgcolor="rgba(0,0,0,0)",
                font=dict(size=11),
            )
            st.plotly_chart(fig_hist, use_container_width=True)
        else:
            st.info("No closed cases with valid resolution times.")

    # ===== REPEATS =====
    with tab_repeats:
        st.subheader("Addresses with ≥3 cases")
        if not aggs["top_addresses"].empty:
            st.dataframe(
                aggs["top_addresses"],
                use_container_width=True,
                height=380,
                column_config={
                    "site_address": st.column_config.TextColumn("Address", width="large"),
                    "cases": st.column_config.NumberColumn("Cases"),
                    "open_now": st.column_config.NumberColumn("Open"),
                    "last_case": st.column_config.DatetimeColumn("Latest", format="YYYY-MM-DD"),
                },
            )
        else:
            st.info("No addresses with 3+ cases under current filters.")

        st.subheader("Owners with ≥5 cases")
        if not aggs["top_owners"].empty:
            st.dataframe(
                aggs["top_owners"],
                use_container_width=True,
                height=380,
                column_config={
                    "owner": st.column_config.TextColumn("Owner / Entity", width="large"),
                    "cases": st.column_config.NumberColumn("Cases"),
                    "properties": st.column_config.NumberColumn("Properties"),
                    "open_now": st.column_config.NumberColumn("Open"),
                },
            )
        else:
            st.info("No owners with 5+ cases under current filters.")

        st.caption("Chronic properties and owners from the current filter set.")

    # ===== ABOUT =====
    with tab_about:
        st.markdown("""
        ### About Cape Coral Code Watch

        Independent public-records tool built from City of Cape Coral  
        code enforcement data. **Not affiliated with the City.**

        **What it does**
        - Search by address, owner, case number, parcel, or keyword
        - Filter by year, status, type, ZIP
        - Surface repeat properties and owners
        - Show officer activity and resolution times
        - Download filtered results

        **Data**
        - ~647,000 cases (2000–2026)
        - Derived fields: year, days_to_close, is_open
        - Owner/address text is as recorded by the City

        Use for citizen oversight, local journalism, and property research.  
        Verify individual cases before drawing conclusions.
        """)


if __name__ == "__main__":
    main()
