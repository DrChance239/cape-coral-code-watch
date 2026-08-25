# Cape Coral Code Watch

Independent public-records accountability tool for City of Cape Coral code enforcement cases.

- ~647,000 cases (2000–2026)
- Search by address, owner, case number, parcel, or keyword
- Filters, analytics, officer activity, repeat properties/owners
- Mobile-friendly

**Not affiliated with the City of Cape Coral.**

## Deploy on Streamlit Community Cloud

1. Make sure `cases.parquet` is in this repository (root or same folder as `app.py`).
2. Go to [share.streamlit.io](https://share.streamlit.io)
3. Sign in with GitHub
4. Click **New app**
5. Select this repository, branch `main`, main file path `app.py`
6. Deploy

The app will be available at a permanent URL like  
`https://cape-coral-code-watch.streamlit.app`

## Local run

```bash
pip install -r requirements.txt
streamlit run app.py
```

## Desktop app

Launch the complete dashboard in a native desktop window:

```bash
python desktop.py
```

To build a Windows executable after installing the project requirements:

```powershell
pip install pyinstaller
pyinstaller --noconfirm --onefile --windowed --add-data ".github\extensions\case-search\public;public" desktop.py
```

## Data

`cases.parquet` is a cleaned, optimized version of the public code enforcement records with derived fields (`year`, `days_to_close`, `is_open`).

## Copilot case-search canvas

The repository also includes a project-scoped Copilot canvas at
`.github/extensions/case-search/`. Open **Cape Coral Case Search** from
Copilot to use the supplied dashboard pages for code enforcement, officers,
planning projects, contractors, building permits, inspections, parcel lookup,
public works, and city salaries. The pages that use City open-data services
query those live sources; planning, contractor, and salary pages include their
referenced datasets.

The canvas requires Python with the packages in `requirements.txt` available
to Copilot, plus `cases.parquet` in the repository root.
